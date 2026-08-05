import { NextResponse } from "next/server";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveModelSecrets, resolveProviderSecrets } from "@/lib/models-config-service";

export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读取服务器真实 models.json 中指定 provider 的配置。客户端已不再持有
 * apiKey / 敏感 header 的原始值（GET 只返回脱敏投影），测试模型连接时
 * 需要用服务器现值补全被掩码/缺失的密钥。
 */
function readServerProvider(providerName: string): Record<string, unknown> | undefined {
  try {
    const modelsPath = join(getAgentDir(), "models.json");
    if (!existsSync(modelsPath)) return undefined;
    const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers?: Record<string, unknown> };
    const provider = parsed.providers?.[providerName];
    return isRecord(provider) ? provider : undefined;
  } catch {
    return undefined;
  }
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function POST(req: Request) {
  let tempDir: string | undefined;

  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown; model?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ ok: false, error: "providerName is required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ ok: false, error: "provider is required" }, { status: 400 });
    if (!isRecord(body.model)) return NextResponse.json({ ok: false, error: "model is required" }, { status: 400 });

    const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
    if (!modelId) return NextResponse.json({ ok: false, error: "Model ID is required" }, { status: 400 });

    tempDir = mkdtempSync(join(tmpdir(), "pidance-model-test-"));
    const modelsPath = join(tempDir, "models.json");

    // 客户端 apiKey 缺失/掩码（"***"）时回退到服务器现值；headers 同样按
    // 保留/更新语义合并（掩码键保留服务器值），保证测试用真实凭据跑通。
    const serverProvider = readServerProvider(providerName);
    const providerBase: Record<string, unknown> = { ...(body.provider as Record<string, unknown>) };
    delete providerBase.models; // 被测模型单独处理，不沿用客户端 models 列表
    const providerResolved = resolveProviderSecrets(providerBase, serverProvider);
    const serverModel = (Array.isArray(serverProvider?.models) ? serverProvider.models : []).find(
      (entry) => isRecord(entry) && entry.id === modelId,
    );
    const modelResolved: Record<string, unknown> = { ...(body.model as Record<string, unknown>), id: modelId };
    resolveModelSecrets(modelResolved, isRecord(serverModel) ? serverModel : undefined);

    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        [providerName]: {
          ...providerResolved,
          models: [modelResolved],
        },
      },
    }, null, 2), "utf8");

    const modelRuntime = await ModelRuntime.create({ modelsPath });
    const loadError = modelRuntime.getError();
    if (loadError) return NextResponse.json({ ok: false, error: loadError });

    const model = modelRuntime.getModel(providerName, modelId);
    if (!model) return NextResponse.json({ ok: false, error: `Model not found: ${providerName}/${modelId}` });

    const resolved = await modelRuntime.getAuth(model);
    if (!resolved?.auth.apiKey) {
      return NextResponse.json({ ok: false, error: `No API key found for "${providerName}"` });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let status: number | undefined;
    const startedAt = Date.now();

    try {
      const message = await completeSimple(model, {
        messages: [{
          role: "user",
          content: "Reply with OK only.",
          timestamp: Date.now(),
        }],
      }, {
        apiKey: resolved.auth.apiKey,
        headers: resolved.auth.headers,
        maxTokens: 16,
        timeoutMs: TEST_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
        onResponse: (response) => { status = response.status; },
      });

      const latencyMs = Date.now() - startedAt;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return NextResponse.json({
          ok: false,
          error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
          latencyMs,
          status,
        });
      }

      return NextResponse.json({
        ok: true,
        latencyMs,
        status,
        responseText: getAssistantText(message).slice(0, 300),
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
