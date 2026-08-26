import { defineConfig } from 'vitepress'

// Served at https://diffohq.github.io/diffo/. Both of these become '/' and the bare
// domain when moving to a custom domain — they are here rather than inline because
// `head` needs them too: VitePress prepends `base` to markdown links, never to a
// head href, and og:image has to be absolute to work at all.
const base = '/diffo/'
const site = `https://diffohq.github.io${base}`

const description =
  'The human way to review agent-written code: a live review on your machine, wired to the agent that wrote it, so your comments come back as fixes'

export default defineConfig({
  title: 'Diffo',
  description,
  base,
  lang: 'en-US',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Diffo' }],
    ['meta', { property: 'og:title', content: 'Diffo' }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:url', content: site }],
    ['meta', { property: 'og:image', content: `${site}social-preview.png` }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${site}social-preview.png` }],
  ],

  lastUpdated: true,
  themeConfig: {
    logo: { light: '/logo.svg', dark: '/logo-dark.svg', alt: 'Diffo' },
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/cli' },
      { text: 'FAQ', link: '/faq' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Your first review', link: '/tutorial' },
          { text: 'The review loop', link: '/guide/the-loop' },
          { text: 'How it works', link: '/guide/how-it-works' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Keyboard shortcuts', link: '/reference/keyboard-shortcuts' },
          { text: 'The agent protocol', link: '/agents' },
        ],
      },
      {
        text: 'Under the hood',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'Security model', link: '/security' },
          { text: 'FAQ', link: '/faq' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/DiffoHQ/diffo' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@diffohq/diffo' },
    ],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/DiffoHQ/diffo/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message:
        'Released under the <a href="https://github.com/DiffoHQ/diffo/blob/main/LICENSE">Apache-2.0 License</a>.',
      copyright: 'Copyright © 2026 Diffo. Diffo is a trademark of Diffo.',
    },
  },
})
