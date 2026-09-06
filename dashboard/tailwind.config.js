/** @type {import('tailwindcss').Config} */

// Palette imported from the "Polymarket Bot Dashboard" design canvas.
// The families below are deep-merged into Tailwind's defaults, so every
// existing `text-green-400` / `bg-poly-dark` in the app picks up the new
// design language without touching the markup.
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Space Grotesk"', '"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Surfaces
        'poly-dark': '#06060a',      // page background
        'poly-card': '#101019',      // raised card
        'poly-gray': '#0b0b12',      // inset surface
        'poly-deep': '#0a0a11',      // card gradient tail
        'poly-border': '#1c1c28',
        'poly-border-soft': '#14141d',

        // Accents
        'poly-purple': '#9b8cff',
        'poly-blue': '#4aa8ff',
        'poly-green': '#34e0b0',
        'poly-red': '#ff6b7a',
        'poly-yellow': '#ffc46b',
        'poly-cyan': '#45c8d8',
        'poly-pink': '#d38bff',
        'poly-orange': '#ff8a5b',

        // Remapped families (deep-merged onto Tailwind defaults)
        gray: {
          200: '#e9e9f2', 300: '#c9c9dc', 400: '#a9a9c0', 500: '#9494ad',
          600: '#6f6f88', 700: '#1a1a25', 800: '#14141d', 900: '#0a0a11',
        },
        slate: { 400: '#a9a9c0', 500: '#9494ad', 600: '#6f6f88' },
        green: { 300: '#7defc9', 400: '#34e0b0', 500: '#34e0b0', 600: '#22c79a' },
        emerald: { 300: '#7defc9', 400: '#34e0b0', 500: '#34e0b0', 600: '#22c79a' },
        teal: { 400: '#34e0b0', 500: '#34e0b0' },
        red: { 300: '#ffa3ad', 400: '#ff6b7a', 500: '#ff6b7a', 600: '#f2495c' },
        purple: { 300: '#c3b8ff', 400: '#b8aaff', 500: '#9b8cff', 600: '#7a67f0' },
        indigo: { 400: '#b8aaff', 500: '#9b8cff' },
        violet: { 400: '#b8aaff', 500: '#9b8cff' },
        blue: { 300: '#93cbff', 400: '#4aa8ff', 500: '#4aa8ff', 600: '#2f8ce0' },
        cyan: { 400: '#45c8d8', 500: '#45c8d8' },
        yellow: { 300: '#ffdca0', 400: '#ffc46b', 500: '#ffc46b', 600: '#eaa940' },
        amber: { 400: '#ffc46b', 500: '#ffc46b' },
        orange: { 400: '#ff8a5b', 500: '#ff8a5b' },
        pink: { 400: '#d38bff', 500: '#d38bff' },
        fuchsia: { 400: '#d38bff', 500: '#d38bff' },
      },
      borderRadius: {
        panel: '20px',
        card: '18px',
        control: '12px',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
        'glass-gradient': 'linear-gradient(160deg, #101019 0%, #0a0a11 100%)',
        'card-gradient': 'linear-gradient(160deg, #101019 0%, #0b0b12 60%, #0a0a10 100%)',
        'green-glow': 'linear-gradient(140deg, rgba(52,224,176,0.16) 0%, rgba(52,224,176,0.04) 100%)',
        'red-glow': 'linear-gradient(140deg, rgba(255,107,122,0.16) 0%, rgba(255,107,122,0.04) 100%)',
        'purple-glow': 'linear-gradient(140deg, rgba(155,140,255,0.16) 0%, rgba(155,140,255,0.04) 100%)',
        'blue-glow': 'linear-gradient(140deg, rgba(74,168,255,0.16) 0%, rgba(74,168,255,0.04) 100%)',
      },
      boxShadow: {
        'glow-green': '0 0 0 1px rgba(52,224,176,0.28), 0 10px 32px rgba(52,224,176,0.18)',
        'glow-red': '0 0 0 1px rgba(255,107,122,0.28), 0 10px 32px rgba(255,107,122,0.18)',
        'glow-purple': '0 0 0 1px rgba(155,140,255,0.28), 0 10px 32px rgba(155,140,255,0.20)',
        'glow-blue': '0 0 0 1px rgba(74,168,255,0.28), 0 10px 32px rgba(74,168,255,0.18)',
        'glow-yellow': '0 0 0 1px rgba(255,196,107,0.28), 0 10px 32px rgba(255,196,107,0.18)',
        'card': '0 1px 0 rgba(255,255,255,0.02) inset, 0 10px 30px rgba(0,0,0,0.45)',
        'card-hover': '0 1px 0 rgba(255,255,255,0.04) inset, 0 18px 44px rgba(0,0,0,0.55)',
        'float': '0 14px 40px rgba(0,0,0,0.6)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shimmer': 'shimmer 2s linear infinite',
        'float': 'float 3s ease-in-out infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
        'fade-in': 'dcFade 0.35s ease-out both',
        'scale-in': 'scaleIn 0.2s ease-out',
        'counter': 'counter 0.5s ease-out',
        // Design-canvas motion vocabulary
        'rise': 'dcRise 0.65s cubic-bezier(0.2,0.8,0.2,1) both',
        'pop': 'dcPop 0.5s cubic-bezier(0.2,0.8,0.2,1) both',
        'draw': 'dcDraw 1.4s ease-out both',
        'dot': 'dcPulse 2.2s ease-in-out infinite',
        'sheen': 'dcSheen 12s ease-in-out infinite',
        'drift': 'dcDrift 26s ease-in-out infinite',
      },
      keyframes: {
        dcRise: {
          from: { opacity: '0', transform: 'translateY(14px) scale(0.985)' },
          to: { opacity: '1', transform: 'none' },
        },
        dcFade: { from: { opacity: '0' }, to: { opacity: '1' } },
        dcDraw: { from: { strokeDashoffset: '1' }, to: { strokeDashoffset: '0' } },
        dcPop: {
          '0%': { opacity: '0', transform: 'translateX(-8px) scale(0.96)' },
          '60%': { transform: 'translateX(0) scale(1.01)' },
          '100%': { opacity: '1', transform: 'none' },
        },
        dcPulse: {
          '0%, 100%': { opacity: '0.55', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.35)' },
        },
        dcSheen: {
          '0%': { opacity: '0.25' }, '50%': { opacity: '0.6' }, '100%': { opacity: '0.25' },
        },
        dcDrift: {
          '0%': { transform: 'translate3d(0,0,0)' },
          '50%': { transform: 'translate3d(2%, -3%, 0)' },
          '100%': { transform: 'translate3d(0,0,0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-5px)' },
        },
        glow: { '0%': { opacity: '0.5' }, '100%': { opacity: '1' } },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideDown: {
          '0%': { transform: 'translateY(-10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      backdropBlur: { xs: '2px' },
    },
  },
  plugins: [],
};
