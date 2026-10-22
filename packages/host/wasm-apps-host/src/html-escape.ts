/**
 * 宿主渲染的 `data:text/html` 页面共用的文本转义（骨架页 / 失败页）。
 *
 * 为什么单独一个模块：这两张页面都是**独立文档**（拿不到客户端字典、也不能 import
 * 任何渲染框架），而它们都要把"宿主拿到的字符串"放进 HTML 文本位置（应用名、诊断
 * 信息、重试 URL 的展示）。转义规则必须只有一份 —— 两份手抄会在"某一边漏掉 `"`"
 * 这类细节上发散，而那边的后果是页面结构被应用名打断。
 *
 * **只用于文本位置**：属性值同样适用（本模块产出的是纯文本转义），但脚本字面量
 * 必须走各自的 JSON 序列化（见 `app-window-recovery.ts` 的 `inlineScriptUrl`）。
 *
 * @module @zeokeel/dsh-wasm-apps-host/html-escape
 */

/**
 * 转义进 HTML 文本/属性位置。
 *
 * 覆盖 `& < > " '` 五个字符：前三个会打断标签结构，后两个能逃出属性引号。
 * @param value - 任意字符串（缺省/非字符串由调用方先归一）。
 * @returns 可安全嵌入 HTML 的文本。
 */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}
