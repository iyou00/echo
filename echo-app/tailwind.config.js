/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ayin: {
          900: '#27500A',
          700: '#3B6D11',
          600: '#639922',
          400: '#8FBC57',
          300: '#C0DD97',
          100: '#EAF3DE',
        },
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
      },
      fontFamily: {
        sans: ['-apple-system', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Cascadia Code', 'Courier New', 'monospace'],
        serif: ['Source Han Serif SC', 'Noto Serif CJK SC', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
}
