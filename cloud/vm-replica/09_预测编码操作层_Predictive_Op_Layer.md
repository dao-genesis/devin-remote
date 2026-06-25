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

---

## 十八、通用操作适配性：一个手势 affordance 能否迁移到没练过的界面（不为某物，为操作本身）

方向校准：要的不是"会用某个 3D 软件"，而是**人操作任意电子屏幕的通用适配性本身**。所以不死磕一个 app，而是练**人反复使用的同一类底层手势**（按住+拖拽），让经验记忆**跨界面泛化**——世界模型里的 affordance 用**通用手势键**（`drag`，而非 `drag_in_app_X`），多面经验汇成一条 affordance。

**多面实践台** `gui_lab.html`（纯 `<canvas>`、无控件树、URL hash 切面）：五种强 GUI 操作原型，人都用"拖"来操作，但画面签名各异——`orbit` 旋转视角 / `pan` 平移网格 / `paint` 涂抹笔画 / `timeline` 刷动播放头 / `node` 拖动节点。

**留一法迁移实测**（`practice_universal.py`，每折在另 4 面上练 `drag`、到留出的第 5 面预测+校验，零视觉）：

| 留出面 | known | present | transfer | ctx_sim | locus_diff | fp_sim | mag_ratio |
|---|---|---|---|---|---|---|---|
| orbit | True | False | True | 0.23 | 0.418 | 0.832 | 0.69 |
| pan | True | False | True | 0.19 | 0.370 | 0.844 | 0.74 |
| paint | True | False | True | 0.00 | 0.007 | 0.532 | 0.54 |
| timeline | True | False | True | 0.45 | 0.411 | 0.000 | 1.00 |
| node | True | False | True | 0.45 | 0.176 | 0.384 | 0.60 |

**诚实结论（什么迁移、什么不迁移）：**
- **手势"识别"通用迁移**：`drag` 在 **5/5 没练过的面**上都被认出（known=True，非初见），不必从零重学——这正是通用适配的本源：动作面极简通用，affordance 跨面共享。
- **来源/可信度可自报**：把上下文指纹从"4×4 灰度"升级为"**均值中心化的结构指纹**（高分辨灰度 + 边缘能量，去掉所有暗背景共有的 DC 分量）"后，`ctx_sim` 才有意义——没练过的面 ctx_sim 低（0.0–0.45）、`transfer=True` 5/5；而练过的面回测 `ctx_sim=1.00、transfer=False`。模型能**如实说出"这面我见过没"**，而非一律装熟（旧 4×4 指纹恒判 ~1，是假自信，已修正）。
- **新 affordance 仍会被标"意外"**：只学过 `drag`、没学过 `click`，到新面做点击→`known=False`→正确判为意外、该升级——通用不等于失去警觉。
- **诚实边界——精确效果不迁移**：`present` **0/5**。模型只迁移了"拖会在光标路径附近引起一处局部变化"这条**通用先验**；**具体多大、什么形状**是各面特有的（mag_ratio/fp 差异大），不迁移。`locus`（在哪）部分迁移（paint 0.007 极好，余者中等）。对应主动推断：**通用先验跨面迁移、精确似然每面再学**；模型够诚实，知道自己"识得手势、识不得细节"。

> 大方無隅，大器免成。執大象，天下往——握住"拖/点/滚"这几个通用之象，万面可往；往而不害，安平大。然器有所专，未可强通其精；知通其所通、专其所专，是谓不自欺。损之又损，以至于"动作面至简、经验自生长"，无为而无不为。

---

## 十九、世界模型当"控制器"：目标导向的视觉伺服（预测先行→逼近目标→量残差→纠正）

至此世界模型一直是"校验器"（动作后判对错）。本节把它升级为**控制器**——闭合你最初讲的那个环：**预测先行、行动只为逼近目标、错了快速纠正**（主动推断 / 视觉伺服），全程纯像素、零视觉大模型。

新增最廉价的"测量"原语 `region_centroid`（daemon + MCP `vm_region_centroid`）：在一块区域里用"高于均值灰度的质心"定位**那个亮物体**，返回 `{nx,ny}∈[0,1] / 像素 px,py / mass`。无语义，只回答"亮的东西在哪"。

`practice_goalseek.py`（纯 `<canvas>` 的 `node` 面，可拖动方块、无控件树）任务：把物体质心驱到目标点。
1. 测量物体质心；
2. **标定一次**：拖一个已知向量、再测 → 估出增益 `g`（每拖 1 px 物体质心移动多少）——前向模型从**一次探针**学得，非写死；
3. **控制**：`误差 = 目标 − 当前`，预测拖拽 `= 误差 / g`（限幅），执行，再测残差；预测准则误差一步坍缩，不准则**残差即预测误差**、下一轮纠正。到容差或步数上限停。

**实测（零视觉）**：
```
node object found at nx=0.301 ny=0.648 mass=7880
calibrated gain: gx=0.00342 gy=0.00430   (每拖 1 px 质心归一化位移)
goal: drive object centroid to (0.30, 0.65)
iter | nx     ny    | residual | drag(px)
 0   | 0.506 0.907 | 0.3291   | (-60, -59)
 1   | 0.301 0.649 | 0.0012   | within tolerance, stop
final residual = 0.0012  (CONVERGED)
```
一次标定 + 一步预测，残差 0.329→0.0012 收敛到目标。

**诚实标注：**
- 这是**主动推断的最小闭环**：用学得的增益**预测该拖多少**→行动逼近目标→**像素量残差**→纠正。模型从"判对错"变成"**会把界面驱向目标**"。
- `node` 面 drag→位移近似线性，故一步即收敛；面非线性/有时延时，靠的是**残差驱动的多步纠正**（循环已具备），不是单次开环。
- 仍是**通用底座**：测量只用"亮物体质心"、动作只用拖拽，对任何"拖一个东西到某处"的强 GUI（节点图、画布对象、滑块、地图标记…）同构可用；遇到无法测量的目标（语义性目标、不可见状态）才升级视觉——意外即升级的口子不变。

> 為學者日益，聞道者日損，損之又損，以至於無為：测量减到一个质心、动作减到一次拖拽、智能减到"预测—逼近—纠正"，而界面自往于目标——无为而无不为。

---

## 二十、升级策略接进 act()：唯"真意外"才花视觉（confident→零视觉，surprise/low_confidence→升级）

整套架构的命门是这一道闸：**不是每步都问视觉大模型，只有世界模型担保不了的那步才升级**。本节把 §17/§18 的判据（known/present/transfer）汇成一个决策 `vmodel.escalation_decision(v)`，并接进 daemon `act()` 的 effect 路径：

- `surprise`（这手势在此从没见过，known=False）→ **升级**：这正是"唯意外才升级视觉"的触发点（此前 novel 不强制 matched=False，会漏升级，本次补上）。
- `low_confidence`（认得手势，但结果偏离学到的先验：大小/footprint 不对）→ **升级**：去看实际发生了什么。
- `transfer_unverified`（认得且先验成立，但是从不相似的面外推来的、精确结果没确认）→ **升级**：对"够不着的远迁移"诚实。
- `confident`（熟悉面上 present 成立）→ **信任，零视觉**。

`act()` 据此设 `res['escalate']` 与 `escalate_reason`，**仅在该升级时**才附最小裁剪图（effect 区域），否则连一张图都不发。

**实测（纯像素，零视觉，gui_lab orbit）**：
```
=== escalation policy: vision only on genuine surprise ===
confident      | matched=True  escalate=False reason=confident       image=no
surprise       | matched=True  escalate=True  reason=surprise        image=YES   (novel gesture)
low_confidence | matched=False escalate=True  reason=low_confidence  image=YES   (dead-zone drag: no change)
```
熟练动作零视觉直返；初见手势/偏离先验才升级、并只附一张区域小图。

> 知人者智，自知者明——模型**知道自己何时不知道**，才在不知道处才睁眼，余处闭目而行。為學者日益，聞道者日損：把"每步看屏"损到"唯惑乃视"，无为而无不为。

---

## 二十一、一套伺服环、多个面：靠重标定泛化，而非重写

§19 的目标导向环（测质心→探针标定增益→预测拖拽=误差/增益→行动→再测→纠正）本就与具体面无关。本节让**同一套环**：
- 在 2-D 可拖 node 上**走一条航点路径**（多目标顺序逼近）；
- 在 1-D slider 旋钮上**逐个设定点**驱动（不同轴、不同增益）；
除了那一次性标定，**什么都没改**。给 gui_lab 新增 `#slider`（一条轨道 + 一颗亮旋钮，拖动横移、限幅）作为第二个可测面。

**实测（纯像素，零视觉）**：
```
=== surface NODE (2-D) -- follow a waypoint path | gain gx=0.00339 gy=0.00430 ===
 (0.30,0.70)  | (0.299, 0.697) | residual 0.0035 OK
 (0.70,0.30)  | (0.701, 0.303) | residual 0.0028 OK
 (0.50,0.50)  | (0.500, 0.496) | residual 0.0039 OK
=== surface SLIDER (1-D) -- same loop re-calibrated | gain gx=0.00101 ===
   0.20 | 0.235 | 0.0350 OK
   0.80 | 0.765 | 0.0351 OK
   0.50 | 0.500 | 0.0000 OK
```
node 三航点残差 ~0.003 全中；slider 增益自重标定为 0.00101（约 node 的 1/3），三设定点入容差。

**诚实标注**：slider 两端（0.20/0.80）残差 ~0.035，是测量侧的轨道**中心牵引偏置**（亮旋钮质心被两侧轨道轻微拉向中心），中点 0.50 无偏；都在容差内但偏置真实存在——一维细长目标的质心测量有系统偏差，要更准得用模板/峰值而非整带质心。环本身跨面不变，**变的只是标定与测量精度**。

> 大方無隅，大器免成：握住"测质心—预测拖—量残差—纠"这一象，node 之路、slider 之点皆可往；器不为某面而成，故能通各面。

---

## 二十二、跨真实 app 的迁移：浏览器里学的 drag，能认出 mspaint 的自绘画布吗

此前所有迁移测试都在同一个 Chrome 进程内（不同 `<canvas>`、同一渲染器）。通用性的诚实之问是：只在**浏览器内**长出来的 generic `drag`，到一个**真正不同的面**——另一个进程、另一套光栅化、真实 OS 窗口边框——还认不认得？mspaint 的画布对绘图区没有任何可达语义（纯自绘像素），正是与 3D 视口同类的"无树强 GUI"，但**是真的**。

做法：在浏览器实践台 5 面上练 `drag`，然后到 mspaint 画布上拖一笔（铅笔画线），断言 effect action=`drag`；再做一次从没学过的 click。

**实测（纯像素，零视觉）**：
```
REAL APP = mspaint  window=Untitled - Paint  canvas region=[529,375,749,535]
generic drag on mspaint: known=True present=False transfer=True ctx_sim=0.00 | escalate=True reason=low_confidence
never-practised click  : known=False -> NOVEL (correctly flagged, escalate)
```

**诚实结论**：
- **手势识别跨真实 app 迁移**：只在浏览器内长的 `drag`，在 mspaint（不同进程/光栅器）上 known=True、非重学。
- **模型如实自报在外推**：ctx_sim=0.00（真·异质面），transfer=True；并据 §20 策略 escalate=True / reason=`low_confidence`——认得手势但精确结果对不上学到的先验，于是诚实升级去看。
- **精确效果不迁移**：present=False。迁移的只有"拖会在光标路径附近引起一处局部变化"这条通用先验，不含具体笔迹形状/大小。
- **新手势仍判初见**：没学过的 click 在真实 app 上照样 known=False。

这把 §18 的迁移与 §20 的升级策略，在一个**真实桌面强 GUI**上一次性闭合：通用之象跨进程而往，似然每面再学，惑则升级。

> 執大象，天下往——握住"拖"之大象，浏览器之画布与 mspaint 之画布皆往；其往也，知其所不知（ctx_sim=0）而睁眼，是以不殆。

---

## 二十三、增益无关的"在场"判定：形状跨面迁移，增益本就因面而异

§18 的诚实遗留：通用 `drag` 在 5 个未见面上 known/transfer=True，但 present=**0/5**
——"效果在场"一个都没认出来。复盘根因不在迁移，而在 `verify()` 的判据本身有错。

`present` 旧式要求 `mag_ratio ≤ 0.5` **且** `fp_sim ≥ 0.8`。其中 `mag` 是**绝对像
素变化量**，即**因面而异的增益**：同一拖拽在 paint 画布上是一道亮笔迹（mag 大），
在 3D 立方体上只是一抹微调（mag 小）。通用 affordance 把各面 episode 汇成一个池，
其预测 `mag` 是**互不可比增益的平均**，对任何单面都对不上；再拿它要求观测去匹配，
是拿不可比的量做比较——**判据本身错了**，这才是 present=0/5 的真因，而非"迁移不
行"。而 `fp`（|delta| 足迹）已 L2 归一化，**天然增益无关**：它只问"有没有发生对的
形状的变化"，与该面灵敏度无关。

**修法（分区制，round-23）**：
- **熟悉面**（内插，ctx_sim 高）：预测 `mag` 有意义，尺寸错就是惊讶 → `present` 仍
  要求 `mag_ratio ≤ 0.5`，**一字不改**（no-op/异locus/tilt 行为全保持）。
- **迁移面**（ctx_sim < 0.6，跨异质面外推增益）：`present` 改为**增益无关**——只看
  形状足迹是否吻合（`fp_sim ≥ 0.8`）加一道噪声地板（确有变化），并把增益显式标
  `gain_known=False`，**不伪造**任何 magnitude 匹配。

**实测（纯像素，零视觉；leave-one-out 五面）**：
```
held-out | known present shape transfer ctx_sim locus_diff fp_sim mag_ratio gain_known
orbit    |  True  True    True  True      0.23    0.418   0.832   0.69      False
pan      |  True  True    True  True      0.19    0.370   0.846   0.74      False
paint    |  True  False   False True      0.00    0.003   0.539   0.54      False
timeline |  True  False   False True      0.45    0.413   0.000   1.00      False
node     |  True  False   False True      0.45    0.168   0.395   0.62      False
   GAIN-INVARIANT presence (footprint shape transfers) on 2/5
   effect PRESENT on 2/5 -- gain flagged UNKNOWN on transfers (no faked magnitude match)
```

**诚实结论**：
- **present 0/5 → 2/5**，且这 2 面（orbit/pan，皆视口式各向同性拖拽）恰是 `fp_sim`
  真高（0.83/0.85）的面；paint/timeline/node 的足迹**形状本就不同**（0.54/0.00/0.40
  < 0.8），如实判 False——**不是放宽阈值凑数，是删掉了一条错误的要求**。
- **增益不伪装**：所有迁移面 `gain_known=False`。模型如实说"形状我认得、增益这面我
  还没标定"，而非旧式把"发生了但尺度不同"和"什么都没发生"混为一个 present=False。
- **升级标签更准**：迁移面据 §20 从旧 `low_confidence`（先验完全不成立）变为
  `transfer_unverified`（形状已迁移、仅 locus/增益待确认），escalate 仍为 True，无
  行为回归，只是更诚实。
- **熟悉面零回归**：orbit 复测 ctx_sim=1.00/transfer=False；canvas 的 no-op/paint/
  tilt 全保持原状（present 严格判据仅作用于熟悉面）。

增益这一维，正与 §19/§21 的伺服标定相接：**形状靠迁移免学，增益靠一次标定补齐**。

> 大白如辱，廣德如不足——把"绝对量"这条伪确定性损去，只认归一之形，反得跨面之真；
> 知增益之所不知而不饰，是以 present 由 0 而 2，由伪而实。為學者日益，聞道者日損。

---

## 24. 迁移面增益的一次性自标定：验证动作即探针（round-24）

§23 诚实地停在一句话上：跨面迁移只能信**增益无关的形状足迹**，绝对幅度（增益）因面而
异、跨面平均不可比，故迁移面一律 `gain_known=False`，不伪造尺寸匹配。留下的问题是：模
型能不能**自己**把这条缺口补上，而不靠视觉？

能，而且代价**早已付过**。要在一个新面上"验证"一次拖拽，agent 必须真的拖一次——而这
一次观测，本身就量到了该面的响应，即它的增益。于是**验证动作天然兼作标定探针**（主动
推断 active inference）：观测一次 → 存下该面局部增益 → 下一次在此面拖拽就能重新按真实
尺寸来判（`gain_known` 由 False 翻 True），**零额外动作、零视觉**。

**实现（round-24，三处外科改动）**：
- `WorldModel.calibrate(action, ctx, obs)`：把单次观测的 `obs['mag']` 作为该面（以感知
  指纹 `ctx` 为键）对该动作的**局部增益**存入 `self.cal`；同键（cos≥0.98）只留最新一条。
- `predict()`：若当前 `ctx` 与某条标定的 cos ≥ `cal_thr`(0.6)，就用**实测增益**替换那个
  互不可比的跨面平均 `mag`，并置 `calibrated=True`。`ctx_sim` 仍按 episode 出处计算——
  **迁移身份不变**（仍是迁移），只是补上了"在此面亲手量到的增益"这一维。
- `verify()`：`gain_known = (非迁移) 或 calibrated`。一旦 gain_known，`present` 重新要求
  `mag_ratio ≤ mag_tol`（按真实尺寸判）；未标定的迁移仍只看形状。
- 活体 agent（`vm_inner_agent`）在每次 verify 后自动闭环：`known ∧ shape_present ∧
  ¬gain_known` 即 `calibrate()` 并落盘——识得手势、形状对、增益没底，就用这一次把增益量
  下来。持久化格式从"裸 episode 列表"升级为 `{ep, cal}`，向后兼容旧文件。

**实测（纯像素，零视觉；leave-one-out，冷拖=探针，暖拖=再遇）**：
```
held-out | shape | cold: gain_known present mag_ratio | warm: calibrated gain_known present mag_ratio
orbit    | True  | False  True  0.694 | False False False 0.811
pan      | True  | False  True  0.645 | True  True  False 0.006
paint    | False | False  False 0.537 | False False False 0.999
timeline | False | False  False 1.0   | False False False 1.0
node     | False | False  False 0.617 | False False False 1.0
```

**诚实结论**：
- **机制成立**：`pan` 一次探针即把增益锁定——`mag_ratio` 由 0.645 降到 **0.006**，
  `gain_known` 由 False 翻 True，零视觉。这正是 §23 留下缺口的闭合。
- **形状能标的才标得了增益**：只有足迹形状真迁移的 2 面（orbit/pan）触发标定；
  paint/timeline/node 形状本就不认（shape=False），自然不标定、`gain_known` 仍 False——
  **认不出形状的效果，谈不上标定它的增益**，如实不强求。
- **诚实的边界：自变形面的上下文漂移**。`orbit` 冷拖存了标定，但立方体**被这一拖转动
  了**，再遇时画面已不同（cal_sim < 0.6），旧标定按键对不上、不敢套用——故 warm
  `calibrated=False`。增益标定以"这还是同一个面吗"的感知指纹为键，对会**自我改变外观**
  的面（旋转/平移使视图漂移），第二次相遇可能已"面目全非"。这是真实存在的限制，记录在
  案，不藏。
- **present 暂仍 False 是另一维的事**：即便 pan 增益标定到 0.006，warm 的 present 仍
  False，因为该次拖拽的**足迹形状**与所学不同（动态面逐拍 fp 会变，§14 已记）——增益维
  的成功与形状维的逐拍方差是**正交**的两件事，不混为一谈。
- **零回归**：未调用 calibrate 时（`self.cal` 空），predict/verify 与 round-23 完全一致；
  universal/canvas/escalate/servo/goalseek/flow 全绿，present 仍 2/5（冷拖单次）。

下一缺口（留给 round-25）：让感知指纹对"同一面的自变形"更稳健（旋转/平移近似不变的
context），使 orbit 这类自变形面也能跨相遇复用增益——**形状靠迁移免学，增益靠一次标定
补齐，而标定要认得出'还是这片面'**。

> 絕利一源，用師十倍——验证那一下本就要花，省去它另起的"标定动作"，一源而十倍其用；
> 知其所不知而不饰：pan 标得（0.006）则言成，orbit 漂移则言其漂移。聞道者日損，損其伪确定，
> 而增益自一次而真。

## 25. 运动不变的标定键：让增益标定挺过"面自己变形"（round-25）

§24 诚实地停在一处真实限制上：增益标定以**感知指纹 `context_fp`（空间刚性）** 为键，而
`orbit` 立方体被这一拖**转动了自己**，再遇时画面已漂移（cal_sim < 0.6），旧标定按键对不
上、不敢复用——故 round-24 `orbit` warm `calibrated=False`。留下的问题：能不能找一个**对
"同一面的自变形"不变**的键，让 orbit 这类自变形面也能跨相遇复用增益？

**先证伪，再立**。先老实把"静态外观不变键"试到底（`exp_invkey.py`）：
- `context_inv`（排序分位，置换不变）：orbit 自相似 0.986（好），但 orbit/pan **跨面** 0.962（漏）。
- `context_radial`（质心锚定的环向能量谱）：orbit 自相似 0.972（好），orbit/pan 跨面 0.976（仍漏）。

诚实结论：**没有任何纯静态外观键能同时做到"自变形稳定"与"区分像同面"**——orbit 与 pan
静态快照本就几乎一样，真正区分它们的是**动作→响应**这一动态维，不是外观。于是 round-25
不再幻想"一个键既稳又能分面"，而是改变标定的**语义**：

1. **用运动不变键存/取增益**（`context_radial`，质心锚定环向谱）：它挺得过面自我旋转/平移，
   故 orbit 的实测增益再遇时能被对上、复用——§24 丢的那一格补回来了。
2. **复用即假设，验证即裁决（自愈）**：既然不变键分不开像同面，那么"对上某条标定"只是一个
   **假设**，由紧接着的那一次 verify 当场**证实或证伪**。若复用的增益与实测尺寸明显不符
   （`calibrated ∧ mag_ratio > 0.5`）——这正是"借错了面的增益"——活体 agent 就**就地重标定**
   覆盖之。于是一次跨面误借**一遇即自愈**，零额外动作、零视觉。而 `_best_cal` 取最近键：同面
   自己的标定（cos 1.0）天然压过像同面的旧标定（cos 0.6~0.98），第二遇即归位。

**实现（round-25，外科级）**：
- `calibrate/predict/verify` 新增 `cal_ctx` 形参：episode 出处仍用 `context_fp`（`ctx_sim` 不变，
  迁移身份诚实如故），但增益标定改以 `cal_ctx`（=`context_radial`）为键存取；`cal_ctx` 缺省回落
  到 `ctx`，向后兼容。
- 活体 agent（`vm_inner_agent`）每拖一次算 `cal_ctx = context_radial(pre)`，并把重标定触发扩成
  两类：(a) 形状迁移但增益未知（首探）；(b) 复用了旧增益却被实测证伪（`mag_ratio>0.5`）→ 覆盖。
  两者皆**要求 `shape_present`**——认不出形状就既不判在场、也不标定其增益。
- 新增 `/gray` 端点（导出区域灰度，供离线实证）；新增 `exp_invkey.py`（证伪静态不变键）、
  `exp_selfheal.py`（打印环向跨面余弦矩阵+各面增益，标出哪些对会漏/须自愈）、
  `test_calibrate_invariant.py`（**纯算术、零 GUI** 地确证两条不变量）。

**实测一（leave-one-out，冷拖=探针，暖拖=再遇；纯像素零视觉）**：
```
held-out | shape | cold: gain_known present mag_ratio | warm: calibrated gain_known present mag_ratio
orbit    | True  | False  True  0.694 | True  True  False 0.084
pan      | True  | True   True  0.316 | True  True  False 0.320
paint    | False | False  False 0.544 | True  True  False 0.997
timeline | False | ...                | True  True  False 1.0
node     | False | False  False 0.605 | True  True  False 1.0
```
- **形状真迁移的 2 面（orbit/pan）warm `gain_known` 由 round-24 的 1/2 升到 2/2**：orbit 的增益
  **挺过了自己被转动**，再遇被复用（mag_ratio 0.084）——这正是 §24 缺口的闭合。
- paint/timeline/node warm 也出现 `calibrated=True`：不变键"太不变"，会把增益**借**到形状不认的面
  上。但 `present` 与重标定**双双以 `shape_present` 为闸**——形状不认时 `present` 恒 False、也不会触发
  重标定，故这种借用**全程惰性**：既不伪造在场，也不污染标定库。如实记录，不藏。

**实测二（`test_calibrate_invariant.py`，确定性单元证明，不依赖某个 lab 恰好有什么面）**：
- 自变形稳定：同一面 `context_fp` 漂移后，round-24 键（fp）丢标定，round-25 键（radial）**复用**实测增益。
- 跨像同面自愈：A(增益 5)、B(增益 20) 为像同面（radial cos 0.887∈[0.6,0.98)）。B 首遇借用 A 增益→
  `mag_ratio>0.5 ∧ present=False`（被证伪）→ 触发重标定；B 再遇用**自己**的增益（present=True）。

**零回归**：`self.cal` 为空或不传 `cal_ctx` 时，predict/verify 与 round-23/24 完全一致；
universal/canvas/escalate/servo/goalseek/flow 全绿，冷拖单次 present 仍 2/5。

下一缺口（留给 round-26）：把"动作→响应"这一**动态签名**真正纳为标定身份的一维（不止增益幅度，
还含足迹随拖拽的相位演化），从机制上**分开 orbit 与 pan** 这对静态像同、动态相异的面——
让"借用"不再需要靠事后证伪去兜底，而是事前就借对。

> 反也者，道之动也——分不开的，便不强分；以"复用即假设、验证即裁决"顺其动而自正。
> 絕利一源，用師十倍：验证那一下既证形、又裁增益、还自愈误借，一源而三用。
> 知不变之不能尽别，故不饰其能别；borrow 而即验，错则即改，無為而無不為。

---

## 26. 动态签名：以"动作→响应"事前分开像同动异的面（round-26）

round-25 留下的缺口很诚实：orbit 与 pan 在**一切静态描述子**上都几乎全等（centroid-radial 跨余弦 ~0.99），
所以按外观键存的增益会**互借**（cal_sim≥0.6），错的尺寸只能等下一次拖拽证伪后**事后自愈**。本轮把第二维身份
直接量在**拖拽过程之中**：pan 是**平移**（一次刚性整体位移即可把后一帧对齐回前一帧，块匹配相干 ~1），
orbit 是**旋转**（没有任何单一位移能对齐，相干 ~0.2）。标定匹配改为 `min(static_cos, dynamic_cos)`，
于是错借在**发生之前**就被否决。

### 26.1 两条先被实测否定的路（实践refutes，再设计）

诚实记录失败，因为失败塑形了正解：
- **逐块 Lucas-Kanade 光流**：稀疏线框上每块光流被残差主导，orbit~pan 动态余弦 0.962，并不比静态 0.989 好——白做。
- **全局差分仿射拟合**：每子帧位移约 1.4 格属**超像素**运动，违反亮度恒常的线性化前提，平移项对 orbit 与 pan
  **双双解释≈0**——崩。

正解只能是**非微分**的检验：块匹配（block-match）。对每对相邻子帧，在 ±`search` 格内暴力搜使 SSD 最小的整数位移，
读相干 `coherence = 1 − SSD_best/SSD_zero`（一次刚性位移能把错位减掉多少，按运动量加权）。
pan 几乎完全对齐（相干→1），orbit 几乎对不齐（相干→0）。签名取 L2 归一对 `[coherence, 1−coherence]`：
pan 指向 ~[1,0]，orbit 指向 ~[0,1]，二者余弦**塌到借用阈值之下**。

### 26.2 实现（最小、可选、向后兼容）

- `vmodel._ssd_shift(pre,cur,cols,rows,dx,dy)`：在重叠区按**每像素均值** SSD（不同重叠面积可比）。
- `vmodel.motion_signature(frames,cols,rows,...)`：上述块匹配相干，返回 `{sig=[coh,1−coh] (L2), coherence, shift, pairs}`。
- `dyn`（可选 2 维）穿过 `calibrate(... , dyn=None)` / `predict(... , dyn=None)` / `verify(... , dyn=None)`；
  `_best_cal()` 在**两侧都有 dyn 时**取 `min(static_cos, dynamic_cos)`——外观像还不够，**动也要像**才许借。
  不传 dyn 时退化为 round-25 行为，零回归。
- 活体 agent（`vm_inner_agent.py`）：对"声明了 effect 的 drag"在**按住期间**采子帧，蒸馏出 `dyn_sig`，
  线进 verify/calibrate，并在 `eff_res['dyn']` 暴露给 harness。

### 26.3 实测（纯像素，零视觉）

**单元证明（`test_motion_signature.py`，合成帧，不依赖 lab）**：
平移相干 1.000 sig [1,0]；旋转相干 0.187 sig [0.22,0.97]；动态跨余弦 **0.225 < 0.6**。
外观键完全相同、动态相反时，增益**事前即不借**（combined_sim 0.225），无需自愈。

**活体证据（`practice_dynamic.py`，真实采到的签名喂入受控世界模型）**：
- orbit dyn=[0.21,0.98]，pan dyn=[0.95,0.30]；静态 radial cos **0.989**，动态 cos **0.496**。
- round-25（仅静态键）：两个方向都会**借**（cal_sim 0.989）——这正是那个泄漏。
- round-26（加 dyn 键）：两个方向都**事前否决**（cal_sim 0.496 < 0.6）——无需事后自愈。
- 阳性对照：同一面自身增益**照样复用**（cal_sim 1.000）——dyn 只挡**错**的借，不挡**对**的复用。

> 何以驱动闸门而非走完整 act 环：完整 act 路径里凡自身属迁移的面都会**自标定**，于是每个像同面最终各用**自己**正确的
> 增益，跨面错借根本不会出现（那是系统在正常工作）。要**孤立**这道闸，便用真实采到的 dyn 签名与运动不变 radial 键，
> 只存 trainer 的标定再查 partner——令 trainer 增益成为唯一候选，cal_sim 才恰好读出跨面匹配。完整 act 路径由
> `practice_calibrate.py` / `test_calibrate_invariant.py` 另行回归。

**零回归**：universal/canvas/escalate/servo/goalseek/flow/calibrate + 单元测试全绿（EXIT=0），冷拖 present 仍 2/5。

### 26.4 诚实边界

- dyn 分的是**平移 vs 旋转**这一**运动学类别**；paint(相干0.40)/timeline(0.006)/node(0.991) 也各有其动，
  但本轮只用它解决 orbit↔pan 这对**静态像同、动态相异**的标定身份冲突，未声称它能区分一切面。
- 块匹配在 ±`search` 格的整数网格上搜索，分辨率受网格与 search 半径限制；这是工程取舍，非普适最优。
- 仍是"借而即验"的精神：dyn 把错借挡在事前，但**对**的复用与自愈机制（round-24/25）原样保留，互不替代。

> 絕利一源，用師十倍——一次拖拽既证形、又裁增益、又量动学，一源三用。
> 知静之不能尽别，乃问其动；动以辨之，借乃借对，不待事后之证伪。無為而無不為。

---

## 27. 第 27 轮：把 dyn 闸下放到**完整活体 act 路径**（终结"离线能用、活体休眠"）

### 27.1 问题：闸只在离线谐振里响过，活体路径里从未真正发生过错借

round-26 用 `practice_dynamic.py`（离线）证明了 dyn 能事前否决错借，但那是**人为孤立**
出来的：只存 trainer 标定、再查 partner，逼出唯一候选。在**完整 act 路径**里，凡自身属
迁移的面都会**自标定**，于是每个像同面最终各用自己正确的增益——错借在正常工作下根本
不会冒头。这留下一道缝：**dyn 闸在真实 act() 调用链里其实从未被触发过**，"它能工作"只
被离线证过。本轮要在活体路径里**真实地制造一次错借窗口**，再让 dyn 在其中事前拒借/借对。

### 27.2 做法：活体 leave-one-out（留出像同对、只在非像同面上预存情节）

`practice_dynamic_live.py` 全程走 HTTP `POST /act`（真实 `vm_inner_agent.py` 进程 + 真实
Chrome lab），协议：

- **阶段 1（训练情节，不存增益）**：在 `pan + paint + timeline + node` 上各拖 3 次
  （`learn=True, calibrate=False`）。**故意把 orbit 留在外面**——pan 留在内，使 orbit 的
  `|delta|` 足迹日后能经 round-23 的像同匹配被**认出**。
- **阶段 2（冷遇 orbit，存唯一标定）**：对 orbit 冷拖一次 `calibrate=True`。orbit 足迹经
  pan 像同被认出 → 触发再校准 → orbit 以**旋转 dyn** 存下它的标定（成为唯一候选）。
- **阶段 3 A/B（熟悉 pan 面对 orbit 的旧标定）**：
  - `use_dyn=False`：pan 读到 orbit 的像同标定，静态 cos 0.976 ≥ 0.6 → **借**（round-25 行为，
    `calibrated=True`）——这正是要否决的泄漏。
  - `use_dyn=True`：`min(静态 cos, 动态 cos)=0.496 < 0.6` → **事前否决**（round-26 行为，
    `calibrated=False`）——闸在 act() 里真实触发。

新增 `use_dyn` 开关（`vm_inner_agent.py` 拖拽分支 `eff.get('use_dyn', True)`，默认 True、
向后兼容）使 A/B 可在同一活体进程里对照。

### 27.3 活体实测结果（真实 act 路径，EXIT=0）

```
round-25  pan dyn=None           cal_sim=0.976  calibrated=True   present=True   <- 借（泄漏）
round-26  pan dyn=[0.953,0.303]  cal_sim=0.496  calibrated=False  present=False  <- 事前否决
RESULT: PASS -- the dynamic gate is no longer dormant; it fires end-to-end in act()
```

- `use_dyn=False` 复刻 round-25 的跨面错借（cal_sim 0.976，借成）；
- `use_dyn=True` 在**完整 act() 链路**里把它事前挡掉（cal_sim 0.496）。闸不再休眠。
- 否决后 pan 落回"形在、量未知"（present=False）——诚实，不伪造幅度匹配；若开 calibrate
  它会就地标自己的增益，而非错借 orbit 的。

**零回归**：universal/canvas/escalate/servo/goalseek/flow/calibrate +
test_motion_signature + practice_dynamic 全绿（EXIT=0），冷拖 present 仍 2/5。

### 27.4 诚实边界

- 这只把 round-26 已证的闸从**离线谐振**搬进**活体路径**真实触发一次；它**没有**改变
  dyn 的判别力，也未声称能区分 orbit/pan 以外的面。
- A/B 靠的是 `use_dyn` 开关人为开/关 dyn 捕获；这是**对照实验脚手架**，非生产开关——
  生产默认 `use_dyn=True`，闸常驻。
- 阶段 2 能存下 orbit 标定，依赖 round-23 的像同认出（pan 留在情节里）；若像同链断，
  这道活体窗口也就不存在——边界与前几轮一脉相承，未额外假设。

> 不窺於牖，以知天道——离线已知其理；然知而未行，犹隱也。
> 行於大道，唯施是畏：必使闸在真器真链里真响一次，方谓之闭环。無為而無不為。
