# 图标库选型建议

## 明确推荐：继续使用 Lucide React

建议保留当前项目的 `lucide-react`，统一使用 1.75px 左右描边、`round` linecap、24px viewBox，并建立一张 Pidance 图标映射表。它已经与项目接入，迁移风险最低；Lucide 是 MIT 许可、SVG tree-shaking 友好、组件 API 直观、图标覆盖文件／Git／会话／设置／工具等核心语义，且可直接控制 `size`、`strokeWidth`、`absoluteStrokeWidth`。

## 候选比较

| 库 | 许可 | 体积与集成 | 风格 | 评价 |
|---|---|---|---|---|
| **Lucide** | ISC（原项目图标谱系为 MIT 生态） | `lucide-react` 按需导入，当前已使用 | 轻、圆润、克制 | **推荐**。不破坏现有组件，适合 A／B，也能通过加粗描边服务 C。 |
| **Tabler Icons** | MIT | React 包按需导入，图标数量很大 | 更方、更工程化、1.5px 线 | 备选。若最终押注 C，可获得更多终端和开发工具符号；迁移会改变全站图标轮廓。 |
| **Phosphor** | MIT | React 支持好，weight 有 regular／bold／duotone 等多档 | 性格更强、可做填充与双色 | 备选。适合 B 的状态表达，但 weight 选择多，需先定规范，否则容易混用。 |
| Material Symbols | Apache 2.0 | Web font 或 SVG，变量轴强 | Google 产品感、填充／轮廓混合 | 不建议作为主库。字体加载与基线、网络依赖会增加，且和三套方向的独特气质不够一致。 |
| Font Awesome | CC BY 4.0（免费图标；代码 MIT） | 生态成熟，但免费／Pro 边界和包体需管理 | 识别度高、填充较多 | 不建议。品牌与应用图标混用风险高，默认视觉较厚。 |

## 落地规范

- 语义图标优先：`Folder`、`GitBranch`、`MessageSquare`、`FileCode2`、`Settings2`、`PanelRight`、`Search`、`Plus`、`ChevronRight`、`Play`、`Check`、`CircleAlert`、`Copy`。
- 图标旁始终保留文字或 aria-label；移动底栏不能只靠图形猜测。
- 14px 以下文字旁使用 14–16px 图标，按钮内使用 18px，顶部主要操作使用 18–20px；点击区域最低 40px，移动端最低 44px。
- 禁止用 emoji 代替产品图标；设计稿中的 `⌘`、`□`、`✓` 只是无依赖占位。
- 若迁移：先补 `components/FileIcons.tsx` 和 `components/Icon.tsx` 语义封装，再逐页替换，避免业务组件直接绑定库名。Lucide → Tabler/Phosphor 预计主要影响 import 名称、个别图标缺失映射与描边视觉，不应改动信息架构。
