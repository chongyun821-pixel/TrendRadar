import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt({ html: false, linkify: true, breaks: true });

parser.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
parser.renderer.rules.table_open = (tokens, index, options, _env, renderer) =>
  '<div class="md-table" tabindex="0" role="region" aria-label="표">' + renderer.renderToken(tokens, index, options);
parser.renderer.rules.table_close = (tokens, index, options, _env, renderer) =>
  renderer.renderToken(tokens, index, options) + '</div>\n';

/** 사용자·모델·보고서에 같은 Markdown 렌더러를 적용한다. 원문 HTML은 실행하지 않는다. */
export function md(src: string): string {
  return parser.render(src);
}

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
