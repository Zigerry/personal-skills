---
name: scalable-hierarchy-html
description: 生成和优化用于超大规模层级跟踪、性能分析结果、调用树及嵌套操作数据的独立 HTML 报告。适用于报告包含数千个可折叠节点或数万行数据，需要在不把完整层级载入 DOM 的前提下保持响应流畅；也用于排查层级 HTML 初始加载、全部展开、DOM 膨胀或长字符串重复造成的卡顿。
---

# 大规模层级 HTML

生成或优化可独立打开的层级报告，使数千个树节点和数万条操作记录仍能流畅浏览。不要只根据源文件体积判断性能；重点测量展开后的字符串规模、DOM 节点数、样式与布局开销，以及同时可见的行数。

## 安全边界

1. 未经用户明确授权，不要在浏览器中打开报告。
2. 不要执行不可信报告中嵌入的脚本。
3. 以文本形式检查文件，只解析不可执行的 JSON 数据岛。
4. 修改现有报告前，在原文件旁创建备份。
5. 默认只进行静态检查、JSON 解析、规模计数和 JavaScript 语法检查；不要自行执行完整浏览器渲染。

## 核心架构

### 保持跟踪数据惰性且紧凑

- 将跟踪数据存入 `<script type="application/json">`，不要写成可执行 JavaScript。
- 对重复字符串和类别进行驻留，并通过整数索引引用。
- 将 JSON 中的 `<` 转义为 `\u003c`，避免数据提前结束 `script` 元素。
- 不要在源 HTML 中重复写入每个完整的内核名或函数名。

### 按需渲染层级

- 不要在 `DOMContentLoaded` 阶段递归实例化完整层级。
- 初始只渲染根节点，以及足以理解导航关系的少量直接子节点。
- 未展开分支最初只保留 `<summary>` 和轻量节点标识。
- 分支第一次展开时，才渲染它的直接子节点。
- 除非已经证实存在内存压力，否则缓存已渲染的分支。
- 使用事件委托，不要为每个节点单独绑定监听器。

### 限制初始展开状态

- 不要为所有 `<details>` 元素输出 `open`。
- 默认最多展开根节点或前一至两层。
- 将大型操作列表放在默认折叠的分支内。
- 在树外提供聚合摘要表，使用户不展开层级也能看到关键信息。

### 约束批量控制

- 不要为大型报告提供无条件同步执行的“全部展开”。
- 优先提供“展开下一层”“折叠到根节点”和有限深度控制。
- 如果必须保留全部展开，先警告用户并分批执行；明确说明完全展开后的页面仍可能变慢。
- 批量展开或折叠时，暂时禁用 CSS 过渡。
- 改变数千个后代节点的状态前，先折叠或隐藏其父节点。
- 只查询当前面板，避免反复扫描整个文档。

### 控制 DOM 和渲染预算

初始视图采用以下建议目标：

- DOM 元素少于 20,000 个，最好少于 5,000 个。
- 初始生成标记少于 2 MB，最好低于 500 KB。
- 同时可见的行数不超过数百行。
- 不要同时为数千个展开标记执行动画。

如果完整报告会超过这些限制，必须使用惰性渲染或虚拟化。

### 生成轻量标记

- 使用语义化的 `<details>/<summary>` 表示层级节点。
- 分支实例化时只创建直接子节点。
- 仅在已实例化的分支中加入完整反修饰名称、启动元数据等高成本操作详情。
- 对很长且重复的名称，优先使用点击查看详情面板，不要把它们重复写入每个 `title` 属性。
- 转义所有插入 HTML 的数据。
- 避免为每行添加阴影、粘性后代元素或几何动画等布局开销较大的效果。

## 惰性渲染参考模式

使用节点注册表保存对已解析 JSON 数组的引用：

```javascript
var NODE_REFS = Object.create(null);
var NEXT_NODE_ID = 1;

function nodeShell(node, depth, initiallyOpenDepth) {
  var id = String(NEXT_NODE_ID++);
  NODE_REFS[id] = node;
  var shouldOpen = depth < initiallyOpenDepth;
  var body = shouldOpen ? renderImmediateChildren(node, depth + 1, initiallyOpenDepth) : '';
  return '<details class="node" data-node-id="' + id + '" data-depth="' + depth +
         '" data-rendered="' + (shouldOpen ? '1' : '0') + '"' +
         (shouldOpen ? ' open' : '') + '>' +
         '<summary>...</summary>' + body + '</details>';
}

document.addEventListener('toggle', function (event) {
  var detail = event.target;
  if (!(detail instanceof HTMLDetailsElement) || !detail.open ||
      detail.dataset.rendered === '1') return;
  detail.insertAdjacentHTML('beforeend', renderImmediateChildren(
      NODE_REFS[detail.dataset.nodeId], Number(detail.dataset.depth) + 1, 0));
  detail.dataset.rendered = '1';
}, true);
```

根据报告的数据结构调整这个模式，不要原样照搬。示例显式写入 `data-depth`，确保首次展开时能够计算直接子节点的深度。

## 改动前静态分析

修改报告前，统计：

- 不可执行 JSON 的字符数和解析后的 rank 数。
- 层级节点、可折叠节点、叶节点、操作记录数量及最大深度。
- 预计生成的 HTML 字符数。
- 完全展开后的预计 DOM 元素数。
- 改动后初始实例化的节点数。
- 重复长字符串和重复元数据的规模。

## 验证结果

修改后逐项确认：

1. 除非用户要求修改数据，否则原 JSON 数据岛保持逐字节不变。
2. 无需执行页面 JavaScript 即可成功解析 JSON 数据岛。
3. 启动路径中不存在渲染所有后代节点的急切递归调用。
4. 折叠节点保留了后续渲染自身所需的全部信息。
5. 控件只操作当前 rank 面板，不影响无关的摘要表。
6. 不存在无条件同步执行的“全部展开”循环。
7. 批量操作期间会禁用过渡效果。
8. HTML 闭合标签和脚本边界保持完整。
9. 明确报告剩余风险：即使采用惰性渲染，完全展开超大报告仍然成本很高。

## 修改现有报告

1. 不打开报告，先读取并测量其结构。
2. 备份原文件。
3. 保留不可执行的跟踪数据和现有摘要。
4. 将急切递归渲染替换为按需实例化分支。
5. 将危险的全局控制替换为渐进式、面板内控制。
6. 默认只显示根节点或浅层视图。
7. 执行静态验证，并报告改动前后的确切行为。
