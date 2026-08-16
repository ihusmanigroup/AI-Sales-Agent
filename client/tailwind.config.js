/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Light theme tokens
        background: '#F7F8FA',
        surface: '#FFFFFF',
        elevated: '#F7F8FA',
        muted: '#E5E7EB',
        borderMuted: '#E5E7EB',
        primary: '#2563EB',
        secondary: '#8B5CF6',
        success: '#16A34A',
        warning: '#F97316',
        danger: '#EF4444',
        amber: '#EAB308',
        textPrimary: '#111827',
        textSecondary: '#6B7280',
        textMuted: '#9CA3AF',
        // Sidebar (dark)
        sidebarBg: '#0F1115',
        sidebarBorder: '#1E2127',
        sidebarText: '#F3F4F6',
        sidebarTextSecondary: '#9CA3AF',
        sidebarMuted: '#1E2127',
        // Pill/status colors
        pillSuccess: '#D1FAE5',
        pillSuccessText: '#065F46',
        pillWarning: '#FEF3C7',
        pillWarningText: '#92400E',
        pillDanger: '#FEE2E2',
        pillDangerText: '#991B1B',
        pillPrimary: '#DBEAFE',
        pillPrimaryText: '#1E40AF',
        pillSecondary: '#EDE9FE',
        pillSecondaryText: '#5B21B6',
        pillAmber: '#FEF9C3',
        pillAmberText: '#854D0E',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.04), 0 4px 8px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.05)',
        glow: '0 0 0 1px rgba(37,99,235,0.15), 0 4px 12px rgba(37,99,235,0.1)',
        pop: '0 12px 32px rgba(0,0,0,0.12)',
        sidebar: 'inset -1px 0 0 #1E2127',
      },
      borderRadius: {
        'card': '12px',
        'pill': '9999px',
      },
      keyframes: {
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateX(24px) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateX(0) scale(1)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
      },
      animation: {
        'toast-in': 'toast-in 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scale-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}