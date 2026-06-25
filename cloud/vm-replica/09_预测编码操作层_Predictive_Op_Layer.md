# 09 · 预测编码操作层 — Predictive Operation Layer（主动推断 / Active Inference）

> 「不行而知，不见而名，弗为而成。」
> 把 GUI 操作从「解读—操作—解读」改成「**预测先行 → 行动只为校验预测 → 命中即近零消耗推进 → 预测失败才条件反射式重试 → 仍失败才把意外上报大脑**」。
> 本文是设计本源；实现落在 `agent-vm/vm_inner_agent.py`（纯 stdlib/ctypes，零依赖、可冻结 EXE），经 host daemon 自动代理、`mcp_server.py` 暴露为 MCP 工具；基线对比见 `agent-vm/bench_predictive.py`。

---

## 一、为什么要改（本源诊断）

当前操作层（与 Devin 自身 computer 工具同型）是一个**像素轮询**闭环：

```
screenshot(整屏 PNG 250KB~1.2MB) → 大模型读像素 → 吐坐标 → click(x,y) → 再 screenshot 校验 → 循环
```

每一步都把整张屏幕喂给 LLM「解读」再吐坐标。三大本源代价：

| 维度 | 现状 | 根因 |
|---|---|---|
| 流量/Token | 每步一张全屏 PNG（数百 KB~MB），10 步任务 ≈ 数 MB + ~2N 次视觉推理 | 把「看懂整屏」当成每一步的前置 |
| 延迟 | 截图往返 + 视觉推理（秒级/步） | 感知与决策强耦合、串行 |
| 鲁棒性 | 离屏 RDP 的吞键/丢焦/合并（见 HANDOFF §6）全靠 LLM 重判 | 没有本地反射，抖动也要惊动大脑 |

**关键洞见**：项目里早已埋了一条更便宜的语义通道 —— `ui_tree`（控件树 class/text/rect/id），结构化、几百字节，却没接进操作闭环。人类操作 GUI 也不是每动一下就把整屏重新解析一遍。

## 二、人类本源：预测编码 / 主动推断

神经科学的**预测编码（predictive coding）/ 主动推断（active inference）**：大脑持有对世界的**生成模型（先验预测）**，行动的目的不是「重新感知一切」，而是**去验证/实现预测**；只有当观测与预测不符（**预测误差 / 惊讶 surprise**）时，才触发更新与二次行动。预测命中时资源消耗极低；预测落空时快速纠偏（点一下没反应→立刻再点/双击），直到收敛到期望。

对应到 GUI Agent：
- **生成模型** = 对「这一步动作后界面会变成什么」的预测（`expect`）。
- **行动** = 为验证预测而发出的鼠键事件。
- **感知** = 只取**校验预测所需的最小信号**（签名/哈希/控件状态），而非整屏像素。
- **预测误差** = 预测与最小观测不符 → 先本地**反射重试**，耗尽才把「意外」上报 LLM。

> 一句话：**最小化惊讶**。把昂贵的 LLM 视觉只留给真正的「意外」，其余全部在会话内本地闭环。

## 三、新原语（全部纯 stdlib/ctypes）

| 原语 | 作用 | 数据量级 |
|---|---|---|
| `observe` | 返回**紧凑状态签名**：前台窗口(hwnd/title)+焦点控件(class/text/rect)+前台窗口 UI 树哈希(+可选区域感知哈希) | 数百字节（替代整屏 PNG） |
| `find` | 在 UI 树里按 `text`/`class`/`id`/`regex` **本地定位**元素 → 返回 rect/center | 数百字节，**去坐标化** |
| `region_hash` | 对一个矩形采样 9×8 网格算 64-bit dHash（感知哈希），用于极廉价的变化检测 | 8 字节 |
| `wait_change` | 以签名为基线轮询/阻塞直到状态改变或超时（**事件式校验**，替代轮询整屏截图） | 数百字节 |
| `act` ★ | 预测·行动·校验·反射的核心（见下） | happy path 数百字节 |
| `act_seq` ★ | 预测先行的**批量动作**（speculative multi-action）：一次规划、逐步自验、首个不可恢复误差才中止上报 | N 步共数百字节 |

### `act` 的闭环（核心）

```
act({ op, target, expect, retry? })
  1. resolve target:  语义(text/class/id) --find--> center 坐标   | 或直接 (x,y)
  2. pre  = observe()                      # 抓前签名（廉价）
  3. perform op (click/double/right/move/drag/scroll/type/key/hold)
  4. post = observe()                      # 抓后签名（廉价）
  5. verify expect against post（本地，无 LLM、无整屏截图）:
       命中  -> return {ok, matched:true, attempts, cost:tiny}        # 大脑全程未被惊动
       未命中 -> 反射重试梯（refocus → double_click → 微抖动±jitter → wait+repoll → 重打字带引信）
                每步重新 observe + verify
  6. 反射耗尽 -> return {matched:false, prediction_error:{pre,post diff}, region_png?}  # 仅此时上报 LLM
```

**`expect` 谓词**（可组合，全在本地评估）：
- `foreground` / `foreground_regex`：前台窗口标题包含/正则匹配。
- `focus_class`：焦点控件类名匹配。
- `appears` / `disappears`：某 text/class 的控件在前台 UI 树中出现/消失。
- `value`：某控件（按 selector）的文本等于/包含期望值（WM_GETTEXT）。
- `region_changed` / `region_stable`：指定矩形的 dHash 相对动作前是否变化。
- `changed`：整体签名相对动作前是否变化（最弱默认，「有反应即可」）。

## 四、为何全面超越「截图+点击」（严格超集）

| 维度 | 截图+点击（基线） | 预测编码层（happy path） | 增益 |
|---|---|---|---|
| 每步数据 | 250KB~1.2MB PNG ×（动作+校验） | 数百字节签名 | **~10³×** |
| 视觉/LLM 调用 | ~2N（每步 act+verify 各一次读图） | 1 次规划，逐步 0 视觉 | **N→1** |
| 校验延迟 | 截图往返 + 推理（秒级） | 本地 ms | **秒→毫秒** |
| 抖动鲁棒 | 靠 LLM 重判 | 本地反射重试（命中 HANDOFF §6 全部坑） | 不惊动大脑 |
| 退化保障 | — | 真·意外时回退「截目标区域小图 + 最小 diff」上报，最坏 = 今天的路径 | 严格超集 |

## 五、落地与边界

- **零新依赖**：复用 inner agent 既有 `_capture_bgr / SendInput / ui_tree / foreground_info`，新增 ctypes（`GetGUIThreadInfo`）即可；保持「可 PyInstaller 冻结、注入任意无 Python 的 Windows」的本源约束。
- **代理零改动**：host daemon 已对任意 `vm.<action>` 透明代理（`vm.` 前缀剥离转发），新动作自动可达；只需在 `mcp_server.py` 注册 MCP 工具。
- **闭环验证**：在 Devin 自身 console 会话以 Notepad 工作流端到端跑，`bench_predictive.py` 三维对比基线，迭代收敛。
- **不变式**：语义定位失败/真·意外一律回退像素路径，绝不假装成功；红线（不碰用户文件、专属 tag、离屏保活）全部沿用。

> 反者道之动，弱者道之用。以最小的工程量（一组本地原语）撬动最大的效果：**让大脑只为意外买单**。

---

## 六、v2 · 高强度多应用实践收敛（攻"无控件树"硬场景）

第一版只在 Notepad（控件树丰富）验证，太浅。真正复杂的是**纯 UI、无底层状态、控件树取不到**的软件——画布类（mspaint）、自绘类、商业软件、游戏式交互。把人类操作电脑的各类逻辑（文本编辑 / 画布绘制 / 功能区与菜单 / 按钮阵列 / 对话框 / 右键菜单）逐一在自身 VM 上实跑（`agent-vm/practice_apps.py`），暴露并收敛出三处架构本源问题：

1. **`changed` 不能只看控件树。** mspaint 画布上画一笔：`tree_hash` 纹丝不动（控件树无增量），纯像素变化。→ `changed` 改为**树优先、自动回退到视觉**（`_coarse_visual`，目标区域优先、否则全屏的粗粒度 dHash）。一个谓词在"有树/无树"两个世界都诚实。`reasons` 标注命中路径 `changed=ok(tree|visual)`，可观测。
2. **单点采样漏掉细线/稀疏变化。** 每格只采中心 1 像素时，1px 铅笔线几乎不命中采样点 → 漏判。→ `_grid_gray` 改为**每格 sub×sub 块平均**（默认 4×4），细线/光标/小图标也能移动格值；dHash 与瓦片差分同时变灵敏。新增 `where_changed`（瓦片差分）给出**变化发生在哪里**（changed cells + 屏幕坐标 union bbox），即人类"那边动了一下"的空间感知，几百字节、无 PNG。
3. **反射梯不能盲目重发非幂等动作。** 键盘/打字是非幂等的：重发 `Ctrl+B` 会把加粗又切回去、重发 `type` 会重复输入。原 `type/key` 反射直接重发 → 破坏状态（实测 WordPad 加粗步 attempts=4 且最终错乱）。→ `type/key` 默认反射改为**等待并复检**（键多半已送达，落空多是校验慢/细微），仅当调用方标 `idempotent:true` 才重发。修正后同一步 1 次命中。

**v2 实测**（自身 console 会话，`practice_apps.py`，0 截图 / 0 视觉调用）：

| 应用 | 交互原型 | 结果 | 命中路径 |
|---|---|---|---|
| Notepad | 文本编辑（控件树） | 6/6 | tree / region / foreground |
| WordPad | 富文本 + 功能区 | 4/4 | tree / region |
| mspaint | 画布（无控件树→视觉） | 3/3 | visual / region / tiles(where_changed bbox 精确定位笔画) |
| Calculator | 按钮阵列（语义定位） | 跳过 | UWP XAML 自动化树本进程不可达（如实跳过，不伪装） |

合计 **13/13 命中、1500 字节、0 截图、0 视觉调用**。新增原语：`where_changed`；新增 MCP 工具 `vm_where_changed`。

> 实践即审视，审视即收敛。无控件树处以视觉补之，非幂等处以等待代之，皆"因其自然"。再实践、再完善，循环不止。

---

## 七、v2 round-3 · 瞬态弹窗 + 变化检测灵敏度

继续实践（右键菜单 / 滚动），再收敛两处：

4. **瞬态弹窗（右键菜单/下拉/自动补全/工具提示）不在活动窗口树里。** 它们是**独立顶层窗口**（上下文菜单 class `#32768`，组合框下拉 `ComboLBox` 等），`find`/`appears` 只搜活动窗口的子树 → 看不见菜单（实测 `find "Select All"` 命中 0，因菜单项根本不是 HWND）。→ 新增 `_popup_windows()` / `_menu_open()`（`EnumWindows` 按类名识别，廉价）；新增谓词 **`menu_open`**（菜单是否弹出，True/False 双向校验通过）；`appears` 找不到时**自动加扫弹窗窗口**；`observe(popups=true)` 列出当前弹窗。即人类"右键→菜单弹出来了"的预测校验。
5. **dHash 漏判"保形"变化（如滚动）。** 文本整体滚动时，粗网格的左右明暗**次序**几乎不变 → dHash 比特不翻转，`region_changed` 漏判；而每格**绝对均值**确实移动了。→ 把 act() 的视觉校验统一到 **瓦片均值差**（`_region_gray` + 阈值，与 `where_changed` 同源）：`region_changed/region_stable` 与 `changed` 视觉兜底改为 `dHash 变 OR 瓦片均值变`——严格超集，只增灵敏不减（dHash 仍兜结构性变化），块平均又压住了光标闪烁等噪声误报。

实测 round-3：右键菜单 `menu_open` 弹出/关闭双向命中；`where_changed` 在文本滚动时定位到变化格而 dHash 漏判（佐证统一到瓦片均值的必要）。多应用实践合计 **15/15 命中、0 截图、0 视觉调用**（新增 context-menu 场景 2/2）。

> 弹窗以枚举顶层窗见之，保形变化以瓦片均值察之。所缺者补之，所过者抑之，损之又损，以至于无为而无不为。

---

## 八、v3 round-4 · UI Automation：触达现代 UI 框架（最大杠杆）

实践到"真正复杂的商业软件"，撞上**本源级最大坑**：

6. **原生 HWND 控件树看不见现代 UI 框架。** `find` 走的是 `EnumChildWindows`/`GetWindow` 原生 Win32 句柄树——但 **Windows Ribbon（mspaint/wordpad/explorer）、WPF、UWP/XAML（Calculator）、Chromium/Electron、Qt** 这些框架的控件**根本没有 per-control HWND**（自绘 + 仅经辅助功能层暴露）。实测：mspaint 工具栏 HWND 树只有 `Ribbon`/`UIRibbonWorkPane` 容器；Calculator 整个按钮阵列在 HWND 树里**不可达**（此前只能"如实跳过"）。这正是商业软件的主体形态。
   - → 新增 `uia.py`：**纯 ctypes COM** 实现的极简 `IUIAutomation` 客户端（零 pip 依赖，保持可冻结 EXE）。`CoCreateInstance(CUIAutomation)` → `ElementFromHandle(前台窗)` → `FindAll(Subtree, TrueCondition)` → 逐元素读 `Name/ControlType/ClassName/BoundingRectangle`，在 Python 端按 `text/class/control_type/regex` 过滤，返回 `center` 供点击。
   - → `find` 改为 **`find_any`：先走最廉价的 HWND 树，空了再自动回退 UIA**（人类直觉：先看显眼控件，没有再调更丰富的辅助层）。`_resolve_target` / `appears` / `value` 同步走 `find_any`。响应带 `backend: tree|uia`。
   - → 守护式可选导入：UIA 不可用时静默回退 HWND/视觉，**绝不硬依赖**。`vtable` 下标经实测校正（`get_CurrentBoundingRectangle`=43）；`HRESULT` 用 `c_long` 自查以免 ctypes 自动抛错破坏回退。

实测 round-4（自身 console，`practice_apps.py`）：
| 应用 | 此前 | 现在 | 路径 |
|---|---|---|---|
| **Calculator**（UWP/XAML） | 跳过·不可达 | **7+8=15 全程自动** | UIA find 按钮 + region 校验 + UIA 读回结果 |
| **mspaint Ribbon** | 工具栏不可见 | 'Brushes' 按钮精确定位 @[470,181] | UIA find |

合计 **21/21 命中、2279 字节、0 截图、0 视觉调用**。`find 'Add'` 命中 2 个（含 'Memory add'）→ 用 `regex:^Add$` 精确消歧（substring 默认便利，需要精确时给 regex）。

> 显隐之控件，HWND 见其形于先，UI Automation 通其神于后。先廉后丰，先简后繁，函三层（树/UIA/视觉）于一 `find`，是谓"大制无割"。再实践、再完善，循环不止。

---

## 九、v3 round-5 · 浏览器/网页（Chromium）+ 语义状态内省

实践到"商业软件主体"——**浏览器/网页/Electron**。两点本源发现：

7. **Chromium 网页可经 UIA 语义触达（两层）。**
   - **浏览器框架层**：地址栏（UIA `Edit` "Address and search bar"）、标签、工具栏按钮全部可达 → 可直接以"聚焦地址栏 + 输入 URL + 回车"驱动浏览器，这是最通用的人类上网模式。
   - **网页 DOM 层**：导航到真实页面后，Chromium **把渲染进程的辅助功能树暴露给 UIA**——`Document` / `Text` / `Hyperlink` 等在 `FindAll(Subtree)` 中可见。实测：经我们自己的操作层从地址栏导航到 `example.com`，随即 UIA 命中页内超链接 `'Learn more' @[304,279]`，点击触发跳转（`region_changed` 命中）。即 **网页元素也能语义定位、无需读像素**。
   - 注：新标签页（`chrome://newtab`）首帧未必暴露 DOM；导航到内容页后即可见（Chromium 按需开启 a11y）。深层大页面受 `max_results` 上限约束，够用即止。

8. **预测要验"语义状态"，而非只看像素。** WordPad 选中后 `Ctrl+B` 加粗——文字变粗被**选区高亮遮蔽**，大区域瓦片均值几乎不动（像素层面人也难辨）。
   - → `uia.py` 增 **控件状态内省**：`TogglePattern`（开/关/不定）、`SelectionItemPattern`（是否选中），`uia_find(..., want_state=True)` 时附带 `toggle`/`selected`。CheckBox/RadioButton/真 ToggleButton 由此可直接读状态校验。
   - → WordPad 的 Bold 是 Ribbon 自绘按钮、**不暴露 TogglePattern**（实测 `toggle=None`）。但它**激活时按钮自身高亮**——于是改为**预测效果显现之处**：UIA 定位 Bold 按钮 `@[145,122,168,144]`，`Ctrl+B` 后只监视该按钮小矩形的 `region_changed`，稳定命中。"观其变于所变之处"，比盯整页更准更省。

实测 round-5（自身 console）：新增 web 场景 3/3（地址栏导航 / 网页超链接 UIA 定位 / 点击跳转），wordpad bold 修复为语义校验。多应用合计 **24/24 命中、0 截图、0 视觉调用**。

> 网页非化外之地，UI Automation 通浏览器之神，框架与 DOM 皆可语义而取。状态可读则不臆于像素，变化只观其所显之处。损之又损，以至于无为而无不为，循环不止，推进到底。

---

## 十、v3 round-6 · 鼠标手势补全（双击 / 滚动）

明确点名"不可略过"的手势：**双击、拖拽、滚动**。审视后确认引擎 `act()` 已能分发三者（`_COORD_OPS`），拖拽早由 mspaint 画布笔画覆盖；本轮补齐**双击**与**滚动**两项实践，验证预测·校验在手势上同样闭环：

- **双击选词**：Notepad 输入一行词，`double_click` 于词上 → 选区高亮出现，`region_changed`（限定到该行小区域）命中。
- **滚动**：填 80 行越过视口，`Ctrl+Home` 回顶再 `scroll` 下滚 → 文本整体平移。dHash 对"保形平移"不敏感，正由 round-3 引入的**瓦片均值差**兜住，`region_changed` 命中。

实测 round-6（自身 console）：新增手势场景 2/2（双击选词 / 滚动平移），多应用合计 **26/26 命中、0 截图、0 视觉调用**，均一次命中（`attempts=1`，引擎无需改动）。

> 手之所触，目之所验。双击、拖拽、滚动皆人之本能；预测先行、观变于所变，机亦循之。无为而无不为，循环不止。

---

## 十一、v3 round-7 · 语义状态内省（读其义，非测其素）

round-5 曾尝试以 **Pattern 对象 QI**（`GetCurrentPatternAs`）读控件状态，纯 ctypes 下对内置 provider 返回 `None` 失败、当时**如实回退、不发半成品**。本轮换对路子——**`GetCurrentPropertyValue` + `VARIANT`** 直接取属性值，一举打通：

9. **控件的"意义"可直接读，无需臆测像素。** 定义最小 `VARIANT`（vt + union：BSTR/I4/BOOL/R8），对元素调 `GetCurrentPropertyValue(pid)`：
   - `ToggleState`(30086, I4 0/1/2) — 复选框 / 开关按钮
   - `Value.Value`(30045, BSTR) — 文本框 / 组合框文本
   - `RangeValue.Value`(30047, R8) — 滑块 / 进度条
   - `SelectionItem.IsSelected`(30079, BOOL) — 列表项 / 标签页
   - **按控件类型择属性上报**（否则非该类控件会返回噪声，如窗口本身 toggle=2）。实测 Notepad「查找」对话框 `Match case` 复选框：点击前 `toggle=0`、点击后 `toggle=1`，语义清晰。
   - 取值即 `VariantClear` 释放，零泄漏；纯 ctypes、零依赖、不破坏可冻结 EXE。

   新增能力：`vm.read`（读控件 value/toggle/selected/range）+ `act.expect` 谓词 `checked`/`unchecked`/`state`——**以"它现在是否被勾选/值是否等于 X"这种语义断言来校验结果**，而非区域像素差或截图。这是 round-2「观其变于所变之处」的更进一步：**根本不必看"变"，直接问"是何"**。

实测 round-7（自身 console）：新增 state 场景 3/3（读 toggle=0 / 点击后 `checked` 命中 / 再点 `unchecked` 命中，均 `attempts=1`）。多应用合计 **29/29 命中、2941 字节、0 截图、0 视觉调用**。

> 大象无形，状态有名。读其义，则不臆于像素；问其是，则不卜于变化。属性既得，预测自明。损之又损，循环不止，推进到底。

---

## 十二、v3 round-8 · 推测式批量动作（一谋而众随）

`act_seq`（speculative multi-action）是 round-1 即埋下的核心原语，但一直**未端到端实测**。本轮在 Calculator 上跑通一条**一次规划、逐步自校验**的链：

10. **一谋而众随：一次规划整条动作链，每步本地自验，happy path 零逐步截图/视觉调用。**
    - 链 `7 → + → 8 → =`（按钮皆 UIA 目标），每步带预测（`region_changed` 显示区 / `changed`）。`act_seq` 顺序执行、逐步 `act()` 自校验；某步预测失败即就地走反射梯，仍不可恢复才中断并只在该步回传区域小图（`stop_on_error` 默认真）。
    - 实测：`completed=4/4、all_matched=true`，整条 4 步链合计 **~356 字节**（含每步校验），随后 UIA 读回结果 `15`。即"预测先行"可从单步推广到**整段计划**：规划一次、机器自行验证推进，人/LLM 只在真·意外时介入。

实测 round-8（自身 console）：新增 act_seq 场景 2/2（4 步链一次跑通 / 结果 UIA 读回 15）。多应用合计 **31/31 命中、3297 字节、0 截图、0 视觉调用**。

> 一谋而众随，谋定而后动；动皆自验，验而后进。一以贯之，则万动如一。无为而无不为，循环不止，推进到底。

---

## 十三、v3 round-9 · 审视架构本体：统一"于何处观之"

审视 `_eval_expect` 谓词本体，发现一处**不一致的本源裂痕**：`appears` 谓词会在 round-3 加入的**瞬态弹窗**里兜底搜寻，而 `value` / `checked` / `state` 这三个语义读取谓词**只看前台窗口**。后果：当被校验的控件位于一个**非前台的弹窗/对话框**（弹窗、上下文菜单是独立顶层窗口、不在活动窗口树里）时，语义状态读取会漏判——这正是 round-3、round-5 反复踩到的"弹窗不在活动树"同一个坑，只是这次潜伏在状态读取一侧。

11. **归一"观之之处"：活动窗 → 瞬态弹窗，HWND 树 + UIA，一以贯之。** 抽出 `_find_anywhere` / `_read_anywhere` 两个本源解析器（先活动窗、再逐个弹窗；每处都走 `find_any`/`uia_read`，即 HWND 树空了自动 UIA 兜底），让 `appears`/`value`/`checked`/`state` 四谓词**共用同一套"于何处观之"逻辑**。人眼找控件本就如此：先看当前窗口，没有再扫浮起来的菜单/对话框。
    - 实证：右键唤出上下文菜单后，断言 `appears {text:'Select all', control_type:'MenuItem'}` 命中——该菜单项**根本不在活动窗口的 HWND 树里**（round-3 实测命中 0），却经"弹窗作用域的 UIA"被稳定找到。校验语义状态从此不再受"控件在不在前台树"所限。

实测 round-9（自身 console）：上下文菜单场景新增 1 步（弹窗内 MenuItem 经统一解析可达）。多应用合计 **32/32 命中、3426 字节、0 截图、0 视觉调用**，全套无回归。

> 道泛兮，其可左右。观之有方：先内而后外，先树而后辨。一处之裂，循之于全；归而一之，则无所不照。无为而无不为，循环不止，推进到底。

---

## 十四、v3 round-10 · 文件对话框（无处不在的模态人机交互）

"打开/保存"通用对话框是人操作电脑最高频的交互之一：一个**独立模态窗口**，含文件名输入框、文件列表、按钮。本轮把它当人一样驱动——开、输名、**语义读回**、取消，全程零截图：

12. **模态对话框可全语义驱动，文件名字段值经 UIA 读回校验。**
    - `Ctrl+O` → 断言前台为 `Open`（对话框浮现）。
    - 文件名框默认聚焦，直接 `type 'readme.txt'`，随即以 `state {text:'File name', class:'Edit', value:'readme.txt'}` **经 UIA 读回该字段值**断言——不看像素、不靠区域差，直接问"这个框现在的值是不是 readme.txt"。这正是 round-7 语义内省落到真实模态对话框上的实证（`via=uia-state`）。
    - `click 'Cancel'` → 断言前台回到 `Notepad`（对话框关闭）。该步 `attempts=2`：首次预测未中，反射梯就地重试一次即命中——反射机制在真实对话框上如常生效。

实测 round-10（自身 console）：新增 file-dialog 场景 3/3。多应用合计 **35/35 命中、3796 字节、0 截图、0 视觉调用**。

> 户牖之间，名实可见。开阖有度，问其值而知其是；动有不中，则反射而再行。不出于户，以知其内。无为而无不为，循环不止，推进到底。

---

## 十五、根本转向 · 像素为底座，前向模型从实践生长（攻"纯画布·无语义"）

### 1. 诚实承认天花板
前十轮（语义适配器路线）有一条**硬天花板**：它依赖应用自己吐出控件树/UIA/DOM 才能语义校验。对**没有语义暴露的强 GUI**——3D 建模、视频剪辑、绘画、游戏、CAD——整块画布就是一团自绘像素，没有树可读，交互还是连续的（拖拽旋转视角、拖时间轴、笔刷涂抹）。UIA 那套在那里**全盲**。

**实测取证**（`_probe_canvas.py`，浏览器内 `<canvas>` 作 3D 视口的最小代理，`canvas_lab.html`）：
- 语义层全盲：对画布页面 `find {control_type: Button/Edit/Image/Document}` 一律只返回 **2 个泛化的 Chrome 窗口级 HWND**（窗口标题 + "Chrome Legacy Window"），画布内部**零控件**。
- 像素层有信号但只有二值：拖一下旋转立方体，`region dHash` 翻转、`where_changed` 定位到 bbox——但只能说"那里变了"，**说不出变成什么、是否符合预测**。

这正是要长出的缺口：把"变没变"升级为"变得是否如我所料"。

### 2. 立像素 + 鼠键为唯一通用底座；语义降为"碰巧有就用"的加速器
动作面极简且通用（move/click/drag/scroll/type），感知面也通用（像素）。语义不是总有，像素总在。于是新增一个**从实践生长、纯像素**的前向模型 `vmodel.py`（零依赖、可冻结 EXE）：
- **感知特征**：区域分块灰度网格（沿用既有廉价信号）→ `context_fp`（上下文指纹）。
- **变化描述子** `change_descriptor`：幅度 `mag`（变多少）、质心 `cx/cy`（变在哪）、`fp`（|Δ| 足迹的下采样指纹）、`sfp`（带符号 Δ 指纹）、`aniso`（变化分布的横纵各向异性）。
- **经验记忆** `WorldModel`：累积 `(上下文, 动作, 观测到的局部变化)` 情节；`predict` 用同动作情节按上下文相似度加权平均给出"应当发生的变化"；`verify` 用残差判定"是否如我所料"；**没见过的动作 `known=False`，这才是真正的"意外"——唯此才升级到视觉大模型。**

### 3. 让实践逼出的负面发现驱动结构（三连"试错→收敛"）
在旋转立方体上反复练，**实践当场证伪了我几次自以为是的设计**，这恰是"架构自己长"而非"我钉死"：
- **幅度指纹 `fp`**：相位稳定、足迹稳，但**方向盲**——水平旋转与垂直俯仰都"把立方体点亮"，看着一样。
- **带符号指纹 `sfp`**：能分方向，但对**周期性运动相位依赖**——同一个"右拖"在旋转周期不同相位产生的带符号 Δ 会反相（一次实测 `sfp_sim=-0.521`），不能当稳定匹配键。
- **各向异性 `aniso`**：相位稳定，但它**反映物体形状而非运动轴**——旋转 `-0.42`、俯仰 `-0.44`，照样分不开旋转/俯仰。

**收敛出的诚实版图**：单步 before/after 的廉价像素特征，能稳健给出的是 **presence（有没有发生预期幅度的效果）+ 幅度 + locus（变在何处）+ novelty（没见过=意外）**；**无法**仅凭此判定连续 3D 运动的**精细方向**（旋转 vs 俯仰，同幅同位）——那需要时序/光流，或升级到视觉。`verify` 据此**只用相位稳定特征做判定**，方向（`sfp_sim`/`aniso_diff`）仅作**咨询位**输出，绝不假装能判。

### 4. 闭环实测（`practice_canvas.py`，纯画布、零视觉大模型）
1. **学**：6 次右拖旋转，累积 `drag_right` 情节（`mag≈1.3–2.2`，`aniso≈-0.42` 稳定）。
2. **预测+校验**：新一次右拖 → `MATCH=True`（presence + 同 locus），**零截图零视觉调用**。
3. **空操作**：死区（画布外边距）拖拽 → `mag=0.00`，`present=False` → `MATCH=False`。
4. **异效**：角落画大点 → 幅度更小且 locus 偏离（`locus_diff≈0.29`）→ `MATCH=False`，正确拒绝。
5. **诚实边界**：垂直拖俯仰（同幅同位）→ `present=True`，廉价特征**无法**与旋转区分（`sfp_sim≈0.26` 仅作咨询）→ 如实标注"需时序/光流或视觉升级"，并记为新情节。

经验记忆持久化于 `~/.dao_world_model.json`，越练情节越多、预测越稳。

> 大象无形，大音希声。视之不足见，听之不足闻——画布无名，唯像素常在。知其雄守其雌：能稳判者稳判之（有无、多少、何处、是否初见），未能稳判者不强判而待其时（时序、光流、或问诸视觉）。为学者日益，闻道者日损；前向模型自实践生长，不钉死于先识。无为而无不为，循环不止，推进到底。

---

## 十六、把像素前向模型接进 act() 闭环（语义之外，多一条一等校验路）

§15 的世界模型不再只是旁挂脚本，已**接进 daemon 的 `act()` 主循环并经 MCP `vm_act` 暴露**——成为与"控件树/UIA 语义校验"并列的一条一等校验路，专治画布/无语义场景：

- **新谓词** `expect: {effect: {action, region, learn}}`：`act()` 在执行动作**前**抓该区域 16×16 灰度基线，执行**后**算局部变化描述子，对世界模型 `verify`；命中即 `matched`，**全程零截图零视觉**；`learn`（默认真）则把该情节并入 `~/.dao_world_model.json`，daemon 与练习脚本共用同一份越长越大的记忆。
- **已知失配 = 真预测误差**：`known=True` 但不匹配 → `matched=False`，照常走"意外上报"（区域小图）。**新动作 `known=False`** → 不判失败、只记一笔并标 `novel`，这正是"唯意外才升级视觉"的触发点。
- **非幂等保护**：一旦断言 `effect`，**跳过反射重发**——画布拖拽/滚动是非幂等的，重发只会把视角越转越远，而非重新校验；世界模型只如实报告预测误差。

**经 daemon/MCP 实测**（纯 `<canvas>`，端到端走 `vm_act`，零视觉大模型）：
1. **学**：经 `act()` 连发 6 次右拖，ep0 `novel`、ep1–5 `known`，记忆自动累积。
2. **预测+校验**：新一次右拖 → `matched=True`、`effect.match=True`、`locus_diff=0.018`。
3. **预测误差**：死区拖拽却断言为 `drag_right` → `present=False`、`matched=False`、`attempts=1`（无反射重发）。

至此，"像素 + 鼠键"这条通用底座已真正落进操作闭环：有语义就用语义快校验，没语义就用"实践长出来的局部视觉前向模型"校验，二者在同一个 `act()` 里各司其职。下一步：为"方向"补一条时序/光流线索（让旋转/俯仰可分），并上更多画布面与真·桌面 3D。

> 道生之，德畜之；物形之，器成之。语义者，碰巧之器也；像素者，恒常之道也。器以载道，不以器代道。学不躐等，未能者待其时。无为而无不为，循环不止，推进到底。

---

## 十七、为"方向"补一条时序/光流线索（如实记录：移了针，但没到家）

§15 当场证伪了三个单帧特征、诚实地把"连续 3D 的精细方向"标为判不了。这一节正面攻它——加一条**时序线索**，并把结果如实写下来（不美化）。

**做法**：`drag_sampled` 在**按住左键的整个拖拽过程中**抽 N 个子帧灰度图（连续运动，而非首尾两帧）；`vmodel.flow_axis` 对相邻子帧做**全局 Lucas-Kanade 光流**（由空间梯度 Ix/Iy 与时间差 It 最小二乘解出运动 (u,v)，按较小特征值置信加权、按像素尺度归一化），累加 `|u|` vs `|v|` 得到**主运动轴** `axis∈[-1,1]`：>0 水平（旋转）、<0 垂直（俯仰）。经 daemon 动作 `flow_probe` 暴露。

**如实结果**（纯 `<canvas>` 线框立方体，逐步演进，全部记录在 `practice_flow.py`）：
- 先试**整数块匹配**：子帧位移**小于一个格**，最佳整数偏移恒为 (0,0)→`axis=0`，零分辨力（资源浪费在错方法上，记下来）。
- 再试**亮度偶极**（增亮质心−变暗质心）：四个方向全报水平 `+0.22`——又被**物体形状**带偏（与各向异性同一个坑）。
- 最后 **Lucas-Kanade 光流**：**俯仰**稳定读到负（垂直），但**旋转**信号弱、且**随分辨率翻转**（cols=40 时俯仰分得开、旋转含糊；cols=64 时旋转变清晰、俯仰反而变弱）。

**诚实结论**：时序光流把单帧的"零分辨力"**推到了"平均方向对、但边际小且不稳"**——这是真实进步，也是真实边界。所以 `flow_axis` 作为**咨询位（advisory）发布，绝不作硬判据**：近正面 Y 轴旋转把梯度占优的竖直边沿水平方向只挪一点点，全局光圈（aperture）又把多条异向运动的边平均掉，故旋转净位移本就小——这是可解释的物理限制，不是 bug。要在**任意**连续曲面上稳分方向，得上**稠密/加窗光流 + 显式旋转模型**，或直接**升级视觉**。

> 道之为物，惟恍惟惚。强字之曰"方向"，其犹难名。知其不可强判而标之为"咨询"，不以小margin充大信心——此即不自欺。器有所止，则升于视；学不躐等，未能者待其时。无为而无不为，记其所止，亦推进也。
