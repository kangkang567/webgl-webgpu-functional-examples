/**
 * 功能简介: 页面状态钩子，把脚本运行状态映射到 ui/index.html 的 CSS 状态类
 * 约定:
 *   · body.is-ready  → 画面就绪（暗角淡出等收尾过渡）
 *   · body.is-error  → 显示失败提示 .fallback
 *   · .fallback__text → 写入具体错误信息
 */

export function showError(message) {
  document.body.classList.add('is-error');

  const text = document.querySelector('.fallback__text');
  if (text && message) text.textContent = message;
}
