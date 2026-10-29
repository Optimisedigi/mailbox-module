import { describe, expect, it } from 'vitest'
import { formatGmailDraftHtml } from '@/lib/gmail-service'
import { parseMailComposeContent } from '@/lib/mail/compose-content'
import { inlineEmailListStyles, inlineEmailTableStyles, splitDeclarations, stripEmailFonts } from '@/lib/mail/gmail-html'

// What the compose editor (Lexical) produces for a small table: look comes from CSS classes.
const EDITOR_TABLE =
  '<table class="editorTable"><colgroup><col><col></colgroup><tbody>' +
  '<tr><th class="editorTableHeader" scope="col" style="background-color:rgb(242,243,245);text-align:start"><p class="editorParagraph" dir="ltr"><span style="white-space:pre-wrap">Name</span></p></th>' +
  '<th class="editorTableHeader"><p class="editorParagraph"><span>Cost</span></p></th></tr>' +
  '<tr><td class="editorTableCell"><p class="editorParagraph"><span>Ads</span></p><p class="editorParagraph"><span>(search)</span></p></td>' +
  '<td class="editorTableCell"><p class="editorParagraph"><span>$100</span></p></td></tr></tbody></table>'

const compose = (html: string) => {
  const result = parseMailComposeContent({ html })
  if (!result.ok) throw new Error(result.error)
  return result.value.html
}

describe('inlineEmailTableStyles', () => {
  it('writes borders, padding and collapse inline on table, th and td', () => {
    const out = inlineEmailTableStyles('<table><tr><th>A</th><td>B</td></tr></table>')
    expect(out).toContain('<table style="border-collapse:collapse;font-family:Verdana,sans-serif;font-size:small" cellspacing="0">')
    expect(out).toMatch(/<td style="border:1px solid #9aa0a6;padding:4px 8px;vertical-align:top">/)
    expect(out).toMatch(/<th style="[^"]*border:1px solid #9aa0a6[^"]*background-color:#f1f3f4[^"]*font-weight:700/)
  })

  it('keeps the author’s own styles and does not override them', () => {
    const out = inlineEmailTableStyles('<table style="width:100%;border-collapse:separate"><tr><td style="border:2px dashed red;padding:0">x</td><td style="border-bottom:1px solid #000">y</td></tr></table>')
    expect(out).toContain('<table style="width:100%;border-collapse:separate;font-family:Verdana,sans-serif;font-size:small" cellspacing="0">')
    expect(out).toContain('<td style="border:2px dashed red;padding:0;vertical-align:top">')
    // A side-specific border means "styled": no shorthand is stacked on top of it.
    expect(out).toContain('<td style="border-bottom:1px solid #000;padding:4px 8px;vertical-align:top">')
  })

  it('is idempotent and leaves HTML without tables alone', () => {
    const once = inlineEmailTableStyles('<table><tr><td>x</td></tr></table>')
    expect(inlineEmailTableStyles(once)).toBe(once)
    expect(inlineEmailTableStyles('<p>No table</p>')).toBe('<p>No table</p>')
  })

  it('handles single-quoted style attributes and semicolons inside url()', () => {
    expect(inlineEmailTableStyles("<td style='color:red'>x</td>")).toContain("style='color:red;border:")
    expect(splitDeclarations("background:url(data:image/png;base64,AA);color:red;font-family:'A;B'")).toEqual([
      'background:url(data:image/png;base64,AA)',
      'color:red',
      "font-family:'A;B'",
    ])
  })
})

describe('compose HTML to Gmail', () => {
  it('turns the editor’s class-styled table into a self-contained, bordered table', () => {
    const html = formatGmailDraftHtml(compose(EDITOR_TABLE))
    expect(html).not.toMatch(/class=/)
    expect(html).not.toContain('<colgroup')
    expect(html).toContain('<table style="border-collapse:collapse;font-family:Verdana,sans-serif;font-size:small" cellspacing="0">')
    expect(html.match(/<td style="border:1px solid #9aa0a6;padding:4px 8px;vertical-align:top">/g)).toHaveLength(2)
    // The editor's own header shading is kept, not replaced.
    expect(html).toContain('background-color:rgb(242,243,245)')
    expect(html).toContain('border:1px solid #9aa0a6')
  })

  it('does not stretch table cells with paragraph blank lines', () => {
    const html = formatGmailDraftHtml(compose(EDITOR_TABLE))
    expect(html).toContain('<span>Ads</span><br><span>(search)</span></td>')
    expect(html).toContain('<span>$100</span></td>')
    expect(html).not.toMatch(/<br><br><\/t[dh]>/)
    expect(html).not.toContain('<p')
  })

  it('keeps table text sizes and fonts as authored while normalising the rest to Gmail’s font', () => {
    const html = formatGmailDraftHtml(
      '<p style="font-size:14px">Intro</p><table><tr><td style="font-size:12px;font-family:Arial,sans-serif"><span style="font-size:11px">Cell</span></td></tr></table><div style="font-size:16px;color:#222">After</div>',
    )
    expect(html).toContain('<td style="font-size:12px;font-family:Arial,sans-serif">')
    expect(html).toContain('<span style="font-size:11px">Cell</span>')
    expect(html).toContain('<div style="font-size:small;color:#222;">After</div>')
  })

  it('resumes font normalisation after a nested table closes', () => {
    const html = formatGmailDraftHtml(
      '<table><tr><td><table><tr><td style="font-size:9px">in</td></tr></table><span style="font-size:10px">still in outer cell</span></td></tr></table><span style="font-size:20px">out</span>',
    )
    expect(html).toContain('font-size:9px')
    expect(html).toContain('font-size:10px')
    expect(html).toContain('<span style="font-size:small;">out</span>')
  })

  it('replaces quoted font stacks cleanly instead of leaving fragments', () => {
    const html = formatGmailDraftHtml(`<span style="font-family:Arial,'Open Sans',sans-serif;color:red">x</span>`)
    expect(html).toContain('<span style="font-family:Verdana,sans-serif;color:red;">x</span>')
    expect(html).not.toContain('Open Sans')
  })

  it('still turns top-level paragraphs into Gmail blank lines', () => {
    expect(formatGmailDraftHtml('<p>Hi</p>' + compose(EDITOR_TABLE) + '<p>Thanks</p>')).toContain('</table>Thanks')
  })
})

describe('compose line spacing', () => {
  it('sends each editor line as one Gmail line, with blank lines only where the editor has an empty line', () => {
    // What the editor produces for: "Hey," / "1" / "2" / blank line / "Bullet points:" / list / blank line / "Thanks,"
    const html = formatGmailDraftHtml(
      compose(
        '<p class="editorParagraph" dir="ltr"><span style="white-space: pre-wrap;">Hey,</span></p>' +
          '<p class="editorParagraph"><span>1</span></p><p class="editorParagraph"><span>2</span></p>' +
          '<p class="editorParagraph"><br></p><p class="editorParagraph"><span>Bullet points:</span></p>' +
          '<ol class="editorListNumber"><li value="1"><span>1</span></li></ol>' +
          '<p class="editorParagraph"><br></p><p class="editorParagraph"><span>Thanks,</span></p>',
      ),
    )
    expect(html).toContain(
      '<div dir="ltr"><span>Hey,</span></div><div><span>1</span></div><div><span>2</span></div>' +
        '<div><br></div><div><span>Bullet points:</span></div><ol ',
    )
    expect(html).toContain('</ol><div><br></div><div><span>Thanks,</span></div></div>')
    expect(html).not.toContain('<br><br>')
    expect(html).not.toContain('<p')
  })
})

describe('compose body font', () => {
  it('strips every font and size from the body but keeps colour and weight', () => {
    expect(
      stripEmailFonts(
        `<p style="font-family:Arial;font-size:20px;color:red">a</p><span style='font:12px Georgia;font-weight:700'>b</span><font face="Arial" size="5" color="blue">c</font><li style="--listitem-marker-color:red">d</li>`,
      ),
    ).toBe(`<p style="color:red">a</p><span style='font-weight:700'>b</span><font color="blue">c</font><li>d</li>`)
  })

  it('sends pasted tables and text in Verdana, Normal, even when they carried their own font', () => {
    const html = formatGmailDraftHtml(
      compose('<p style="font-size:24px">Big</p><table><tr><td style="font-family:Arial;font-size:9px"><span style="font-size:30px;color:#cc0000">Cell</span></td></tr></table>'),
    )
    expect(html).toContain('<div data-mailbox-gmail-draft-font="true" style="font-family:Verdana,sans-serif;font-size:small;')
    expect(html).toContain('font-family:Verdana,sans-serif;font-size:small" cellspacing="0">')
    expect(html).not.toMatch(/font-size:(?!small)/)
    expect(html).not.toContain('Arial')
    expect(html).toContain('<span style="color:#cc0000">Cell</span>')
  })
})

describe('inlineEmailListStyles', () => {
  const UL = 'margin-top:6px;margin-bottom:6px;padding-left:22px;list-style-type:disc'
  const LI = 'margin-left:12px;padding-left:2px'

  it('writes the editor’s list look inline: markers, small indent, a slight gap, kept author values', () => {
    expect(inlineEmailListStyles('<ul><li>a</li></ul><ol start="3"><li style="margin-left:0">b</li></ol>')).toBe(
      `<ul style="${UL}"><li style="${LI}">a</li></ul>` +
        '<ol start="3" style="margin-top:6px;margin-bottom:6px;padding-left:22px;list-style-type:decimal"><li style="margin-left:0;padding-left:2px">b</li></ol>',
    )
    expect(inlineEmailListStyles('<p>No list</p>')).toBe('<p>No list</p>')
  })

  it('gives nested lists no gap and second-level markers', () => {
    const out = inlineEmailListStyles('<ul><li>a<ul><li>b</li></ul></li></ul><ol><li>c</li></ol>')
    expect(out).toContain('<ul style="margin-top:0;margin-bottom:0;padding-left:22px;list-style-type:circle">')
    // Back at the top level after the nested list closes.
    expect(out).toContain('<ol style="margin-top:6px;margin-bottom:6px;padding-left:22px;list-style-type:decimal">')
  })

  it('is applied to bulleted and numbered lists from the editor', () => {
    const html = compose('<ul class="editorList"><li class="editorListItem" value="1"><span>One</span></li></ul><ol class="editorListNumber"><li value="1">Two</li></ol>')
    expect(html).toBe(
      `<ul style="${UL}"><li value="1" style="${LI}"><span>One</span></li></ul>` +
        `<ol style="margin-top:6px;margin-bottom:6px;padding-left:22px;list-style-type:decimal"><li value="1" style="${LI}">Two</li></ol>`,
    )
  })

  it('leaves an even gap above and below a list in the sent email', () => {
    const html = formatGmailDraftHtml(compose('<p>See below:</p><ul><li>one</li></ul><p>After</p>'))
    expect(html).toContain(`<div>See below:</div><ul style="${UL}">`)
    expect(html).toContain('</ul><div>After</div>')
    expect(html).not.toMatch(/<br><br><ul/)
  })
})

describe("flattenPreWrapWhitespace (replies quoted by Outlook keep reflowing)", () => {
  it("drops the editor's pre-wrap, so a line break a server or Outlook inserts is just a space", async () => {
    const { flattenPreWrapWhitespace } = await import("@/lib/mail/gmail-html");
    const editor = '<div dir="ltr"><span style="white-space: pre-wrap;">To improve conversions across Google ads</span></div>';
    const out = flattenPreWrapWhitespace(editor);
    expect(out).toBe('<div dir="ltr"><span>To improve conversions across Google ads</span></div>');
    expect(out).not.toMatch(/white-space/);
  });

  it("writes out what pre-wrap preserved: line breaks, runs of spaces, tabs and a leading space", async () => {
    const { flattenPreWrapWhitespace } = await import("@/lib/mail/gmail-html");
    expect(flattenPreWrapWhitespace('<span style="color:red;white-space:pre-wrap">a  b\tc\n d</span>')).toBe(
      '<span style="color:red">a&nbsp; b&nbsp;&nbsp;&nbsp;&nbsp;c<br>&nbsp;d</span>',
    );
    expect(flattenPreWrapWhitespace('<p style="white-space:pre-line">one\ntwo  three</p>')).toBe("<p>one<br>two  three</p>");
  });

  it("follows inheritance and leaves normal text, <pre> and attributes alone", async () => {
    const { flattenPreWrapWhitespace } = await import("@/lib/mail/gmail-html");
    expect(flattenPreWrapWhitespace('<div style="white-space:pre-wrap"><b>x\ny</b><span style="white-space:normal">p\nq</span></div>')).toBe(
      "<div><b>x<br>y</b><span style=\"white-space:normal\">p\nq</span></div>",
    );
    expect(flattenPreWrapWhitespace('<pre style="white-space:pre-wrap">a\n  b</pre>')).toBe('<pre style="white-space:pre-wrap">a\n  b</pre>');
    expect(flattenPreWrapWhitespace("<p>a\nb</p>")).toBe("<p>a\nb</p>");
    expect(flattenPreWrapWhitespace('<span style="white-space:pre-wrap">a<br>b <a href="x?a=1&amp;b=2">l</a></span>')).toBe(
      '<span>a<br>b <a href="x?a=1&amp;b=2">l</a></span>',
    );
  });
});

describe('inlineEmailTableStyles table formats', () => {
  const styleOf = (html: string, selector: string) =>
    (new DOMParser().parseFromString(html, 'text/html').querySelector(selector) as HTMLElement | null)?.getAttribute('style') ?? ''
  const table = (format: string) =>
    `<table data-table-format="${format}"><tr><th>Week</th><th>Spend</th></tr><tr><td>5th Oct - 11th Oct</td><td>$1,244</td></tr></table>`

  it('writes the weekly Google Ads report look: slate header, row rules, first column left, the rest right', () => {
    const out = inlineEmailTableStyles(table('report'))
    expect(styleOf(out, 'th')).toBe(
      'padding:8px 12px;background-color:#f1f5f9;border-bottom:2px solid #e5e7eb;font-size:12px;font-family:Arial,sans-serif;color:#64748b;font-weight:600;white-space:nowrap;text-align:left',
    )
    expect(styleOf(out, 'th:nth-child(2)')).toContain('text-align:right')
    expect(styleOf(out, 'td')).toBe('padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;font-family:Verdana,sans-serif;color:#222;text-align:left')
    // No highlight or colour on any row: the last row looks like the others.
    expect(styleOf(out, 'td:nth-child(2)')).toBe('padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;font-family:Verdana,sans-serif;color:#222;text-align:right')
    expect(out).not.toContain('#9aa0a6')
    expect(inlineEmailTableStyles(out)).toBe(out)
  })

  it('writes the grid and minimal looks, and keeps nested tables to their own format', () => {
    expect(styleOf(inlineEmailTableStyles(table('grid')), 'td')).toBe('border:1px solid #9aa0a6;padding:4px 8px;vertical-align:top')
    // Grid header: the report's light blue (tables with no format keep the grey).
    expect(styleOf(inlineEmailTableStyles(table('grid')), 'th')).toContain('background-color:#f1f5f9')
    const minimal = inlineEmailTableStyles(table('minimal'))
    expect(styleOf(minimal, 'th')).toContain('border-bottom:1px solid #222')
    expect(styleOf(minimal, 'td')).not.toContain('border')
    const nested = inlineEmailTableStyles(`<table data-table-format="report"><tr><td>${table('grid')}</td><td>x</td></tr></table>`)
    expect(styleOf(nested, 'table table td')).toContain('border:1px solid #9aa0a6')
    expect(styleOf(nested, 'table > tbody > tr > td:nth-child(2), table > tr > td:nth-child(2)')).toContain('text-align:right')
  })

  it('keeps a pasted cell’s own border and background in a report table', () => {
    const out = inlineEmailTableStyles('<table data-table-format="report"><tr><td style="border:1px solid red;background-color:yellow">x</td></tr></table>')
    expect(styleOf(out, 'td')).toBe('border:1px solid red;background-color:yellow;padding:6px 10px;font-size:13px;font-family:Verdana,sans-serif;color:#222;text-align:left')
  })

  it('keeps the report fonts through the send pipeline', () => {
    const html = compose(`<p>Hi</p>${table('report')}`)
    expect(html).toContain('font-family:Arial,sans-serif')
    expect(html).toContain('font-size:13px')
  })
})
