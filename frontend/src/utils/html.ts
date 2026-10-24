/* HTML-string helpers for content that is authored as HTML (guidance library) or
   produced from escaped text (markdown answers, highlighted contracts). Output is
   always escaped, so it is safe to render with dangerouslySetInnerHTML. */

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Minimal, safe markdown for AI answers. */
export function md(src: string): string {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    let html = '', list: 'ul' | 'ol' | null = null, inCode = false, code: string[] = [], table: string[] = [];
    const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
    const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
    const flushTable = () => {
        if (!table.length) return;
        const rows = table.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)).map(r => r.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim()));
        html += '<div class="scroll-x"><table><thead><tr>' + rows[0].map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' + rows.slice(1).map(r => '<tr>' + r.map(c => `<td class="${/^[\d,.()\-\s%]+$/.test(c) && /\d/.test(c) ? 'num' : 'wrap'}">${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
        table = [];
    };
    for (const line of lines) {
        if (/^```/.test(line)) { if (inCode) { html += `<pre class="card pad" style="overflow-x:auto;font-size:12px">${esc(code.join('\n'))}</pre>`; code = []; inCode = false; } else { flushList(); flushTable(); inCode = true; } continue; }
        if (inCode) { code.push(line); continue; }
        if (/^\s*\|.*\|\s*$/.test(line)) { flushList(); table.push(line); continue; } else flushTable();
        let m: RegExpMatchArray | null;
        if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flushList(); const h = Math.min(4, m[1].length + 1); html += `<h${h}>${inline(m[2])}</h${h}>`; continue; }
        if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
        if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
        flushList();
        if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    flushList(); flushTable();
    if (inCode) html += `<pre>${esc(code.join('\n'))}</pre>`;
    return html;
}
