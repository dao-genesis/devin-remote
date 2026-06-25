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
