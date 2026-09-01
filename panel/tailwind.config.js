/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // laranja caracteristico do Claude
        claude: { DEFAULT: '#D97757', 600: '#CC785C', 700: '#b5613f', 300: '#e9a78f' },
        ink: { 900: '#0b0d12', 800: '#11141b', 700: '#171b24', 600: '#1f2530', 500: '#2a3140' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Cascadia Code"', 'Menlo', 'Consolas', '"DejaVu Sans Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
}
