/** @type {import('tailwindcss').Config} */
module.exports = {
  // The legacy pages (top-level *.html) and the markup ops.js renders into ops.html (its tables and
  // panels use utilities no page names, e.g. py-8, md:grid-cols-3). Nothing else: the other scripts
  // build no utility classes, and scanning them only adds rules for words in their code (container,
  // ring, static, …). Rebuild: npm ci && npm run build (in frontend/), commit tailwind.css.
  content: ['./*.html', './ops.js'],
  theme: {
    extend: {
      colors: {
        primary: {
          50:  '#EDF1FC', 100: '#DBE3F9', 200: '#B7C6F3', 300: '#93AAEC',
          400: '#5C80E3', 500: '#1D4ED8', 600: '#1943BA', 700: '#143797',
          800: '#0F2970', 900: '#0A1B49', 950: '#06102B',
        },
        secondary: { 500: '#522525', 700: '#391A1A', 900: '#1C0D0D' },
        tertiary:  { 500: '#2B5936', 700: '#1E3E26', 900: '#0F1E12' },
        neutral: {
          50:  '#EBEBEB', 100: '#D8D8D8', 200: '#B1B1B1', 300: '#898989',
          400: '#4F4F4F', 500: '#0A0A0A', 600: '#090909', 700: '#070707',
          800: '#050505', 900: '#030303',
        },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
