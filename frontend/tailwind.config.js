/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./*.html', './academy/**/*.html'],
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
