/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.ejs', './public/js/**/*.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Re-tematización de marca Cash R&R: el color primario del sistema (que
        // en todas las vistas está escrito como `blue`) ahora es VERDE. Así todo
        // el admin cambia sin tocar clase por clase.
        blue: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d',
          950: '#052e16',
        },
        // Acento dorado del logo, disponible como `gold-*`.
        gold: {
          50: '#fbf8ec',
          100: '#f6edc7',
          200: '#eedb8d',
          300: '#e4c451',
          400: '#d4af37',
          500: '#c39a22',
          600: '#a67c17',
          700: '#835f16',
          800: '#6b4d18',
          900: '#5b4019',
        },
      },
    },
  },
  plugins: [],
};
