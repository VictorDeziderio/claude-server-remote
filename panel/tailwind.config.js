/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // laranja/cobre da marca — acao primaria/alerta ("Signal Deck")
        claude: {
          300: '#F3B999',
          400: '#F0985F',
          DEFAULT: '#E37D45',
          500: '#E37D45',
          600: '#C4602D',
          700: '#8F4520',
        },
        // superficies — azul-ardosia quase preto
        ink: {
          950: '#080B11',
          900: '#0B0F17',
          800: '#121826',
          700: '#182238',
          600: '#1E2A45',
          500: '#28375A',
        },
        // "sistema vivo": SSE conectado, remote ON, sessao ociosa-mas-rodando (idle deixa de
        // ser emerald -- emerald fica reservado p/ confirmacao de acao bem-sucedida)
        live: {
          300: '#8CF2E3',
          400: '#4FE0CB',
          DEFAULT: '#22B8A3',
          500: '#22B8A3',
          600: '#1A8F7E',
        },
      },
      fontFamily: {
        // interface (titulos, nav, botoes, corpo de texto)
        sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // dados de UI (metricas, IDs de sessao, comandos, badges) -- NAO e o terminal
        mono: ['"IBM Plex Mono"', '"JetBrains Mono"', 'Menlo', 'Consolas', 'monospace'],
        // terminal (xterm) e CodeMirror -- cobertura de box-drawing p/ TUIs (tmux etc.)
        term: ['"JetBrains Mono"', '"Cascadia Code"', 'Menlo', 'Consolas', '"DejaVu Sans Mono"', 'monospace'],
      },
      fontSize: {
        display: ['1.75rem', { lineHeight: '2.1rem', fontWeight: '700' }],
        title: ['1.125rem', { lineHeight: '1.5rem', fontWeight: '600' }],
        heading: ['0.9375rem', { lineHeight: '1.35rem', fontWeight: '600' }],
        caption: ['0.6875rem', { lineHeight: '1rem', fontWeight: '600', letterSpacing: '0.06em' }],
        'mono-lg': ['1.125rem', { lineHeight: '1.5rem', fontWeight: '600' }],
        'mono-md': ['0.8125rem', { lineHeight: '1.2rem', fontWeight: '500' }],
        'mono-sm': ['0.6875rem', { lineHeight: '1rem', fontWeight: '400' }],
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,.4), 0 12px 24px -12px rgba(0,0,0,.5)',
        elevated: '0 8px 16px rgba(0,0,0,.5), 0 24px 48px -16px rgba(0,0,0,.6)',
        'glow-accent': '0 0 0 1px rgba(227,125,69,.4), 0 0 24px rgba(227,125,69,.25)',
        'glow-live': '0 0 0 1px rgba(34,184,163,.35), 0 0 16px rgba(34,184,163,.25)',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 320ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
}
