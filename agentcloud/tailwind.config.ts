import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Panel kode (gelap, ala IDE)
        ink: {
          950: '#08080E',
          900: '#0C0C15',
          850: '#11111C',
          800: '#161623',
          700: '#1F1F2E',
          600: '#2A2A3C',
          400: '#6E6E85',
          300: '#9A9AB0',
          200: '#C9C9DA',
        },
        // Panel chat (terang, khas VibeCoder)
        accent: {
          50: '#EEF0FF',
          100: '#E0E2FF',
          300: '#A5A8FF',
          500: '#4F46E5',
          600: '#4338CA',
          700: '#8B5CF6',
        },
        paper: '#F5F3FF',
        muted: '#635F82',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        glass: '0 18px 45px -20px rgba(31, 27, 58, 0.35)',
        soft: '0 10px 30px -14px rgba(31, 27, 58, 0.28)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '0.25' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.22s ease-out both',
        'pulse-dot': 'pulseDot 1.1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
