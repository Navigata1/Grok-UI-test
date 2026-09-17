import { describe, expect, it } from 'vitest'
import { escapeHtml, PROOF_COMPETITORS, PROOF_LARGE_PX, PROOF_SMALL_PX, renderProofSheet, type ProofSheetInput } from './proofsheet.js'

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const input: ProofSheetInput = {
  title: 'I Tried 30 Days of Cold Showers',
  channelName: 'Van Life Lab',
  concepts: [
    { name: 'The Result', text: '', focalSubject: 'a frozen beard', colors: ['yellow', 'black'] },
    { name: 'The Stakes', text: 'Or Else', focalSubject: 'me', colors: ['white', 'red'], imageDataUri: PNG_1PX },
  ],
  competitors: ['Cold Plunge Changed My Life', 'Why Cold Showers Are a Scam', '30 Days of Ice Baths', 'A fourth title that must not appear'],
}

describe('renderProofSheet', () => {
  const html = renderProofSheet(input)

  it('is a complete document a browser opens from a file, with inline CSS and no external requests', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<title>Proof sheet · I Tried 30 Days of Cold Showers</title>')
    expect(html).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'")
    expect(html).toMatch(/<style>[^]*<\/style>/)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<link/i)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/@import|url\(/)
    expect(html).toContain('<h1>Proof sheet · Van Life Lab · I Tried 30 Days of Cold Showers</h1>')
  })

  it('has a light and a dark section each showing every concept at 120px beside 240px', () => {
    expect(html).toContain('<section class="light">')
    expect(html).toContain('<section class="dark">')
    for (const name of ['The Result', 'The Stakes']) expect(html.split(`<figcaption>${name}</figcaption>`).length - 1).toBe(4)
    expect(html.split(`class="feed feed-${PROOF_SMALL_PX}"`).length - 1).toBe(4)
    expect(html.split(`class="feed feed-${PROOF_LARGE_PX}"`).length - 1).toBe(4)
    expect(html).toContain('width:120px;height:68px')
    expect(html).toContain('width:240px;height:135px')
  })

  it('draws the placeholder in the concept colours with its text, or its subject when there is no text', () => {
    expect(html).toContain('background:black;color:yellow')
    expect(html).toMatch(/background:black;color:yellow;font-size:\d+px">a frozen beard<\/div>/)
  })

  it('inlines a delivered image as a data URI at both sizes', () => {
    expect(html).toContain(`<img src="${PNG_1PX}" width="120" height="68" alt="The Stakes">`)
    expect(html).toContain(`<img src="${PNG_1PX}" width="240" height="135" alt="The Stakes">`)
  })

  it('draws only the top three competitors as grey placeholders with their titles, in both themes', () => {
    expect(PROOF_COMPETITORS).toBe(3)
    expect(html).not.toContain('A fourth title')
    expect(html.split('class="thumb grey"').length - 1).toBe(2 * 2 * 2 * 3)
    expect(html.split('<figcaption>Cold Plunge Changed My Life</figcaption>').length - 1).toBe(8)
    expect(html).toContain('beside 3 competitor titles')
  })

  it('carries the ritual and a deliberate-drift box', () => {
    expect(html).toContain('Would you click yours?')
    expect(html).toContain('Deliberate signature drift')
  })

  it('is deterministic', () => {
    expect(renderProofSheet(input)).toBe(html)
  })

  it('escapes titles, names and text, and refuses unsafe colours', () => {
    const out = renderProofSheet({
      title: 'Cheap <b>vs</b> "Expensive"',
      concepts: [{ name: '<img src=x onerror=alert(1)>', text: 'A & B', focalSubject: 'x', colors: ['url(evil)', 'red;background:url(x)'] }],
      competitors: ['<script>alert(1)</script>'],
    })
    expect(out).not.toContain('<img src=x')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).toContain('Cheap &lt;b&gt;vs&lt;/b&gt; &quot;Expensive&quot;')
    expect(out).toContain('>A &amp; B</div>')
    expect(out).not.toContain('url(')
    expect(out).toContain('background:#111111;color:#ffd400')
  })

  it('refuses an image that is not a data:image URI', () => {
    expect(() => renderProofSheet({ ...input, concepts: [{ name: 'X', focalSubject: 'x', imageDataUri: 'https://example.com/a.png' }] })).toThrow(/no external requests/)
    expect(() => renderProofSheet({ ...input, concepts: [{ name: 'X', focalSubject: 'x', imageDataUri: 'data:text/html;base64,PGI+' }] })).toThrow(/concept "X"/)
  })

  it('renders an empty sheet without concepts or competitors', () => {
    const out = renderProofSheet({ title: 'T', concepts: [], competitors: [] })
    expect(out).toContain('No concepts yet.')
    expect(out).toContain('0 concepts at 120px and 240px beside 0 competitor titles')
  })
})

describe('escapeHtml', () => {
  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })
})
