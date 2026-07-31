export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();


  // pi-subagents 执行子代理时 spawn pi CLI；将其指向 Pidance 自带依赖，
  // 避免 fallback spawn("pi") 在正式安装环境（PATH 无 pi）产生 ENOENT。
  const { configurePiSubagentBinary } = await import("@/lib/pi-subagent-bridge");
  configurePiSubagentBinary();
}
