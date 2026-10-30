/**
 * ThemeScript - Initializes theme from localStorage before React hydration
 * This prevents the flash of wrong theme on page load.
 *
 * Must be a Server Component: in Next.js / React 19, <script> tags rendered
 * by Client Components are inert on the client. Rendering it from the server
 * inlines the snippet into the SSR HTML so the browser executes it before
 * hydration.
 */
export default function ThemeScript() {
  const themeScript = `
    (function() {
      try {
        const stored = localStorage.getItem('eas-theme');

        const root = document.documentElement;
        root.classList.remove('dark', 'theme-glass', 'theme-snow');

        if (stored === 'dark') {
          root.dataset.theme = 'dark';
          root.classList.add('dark');
        } else if (stored === 'glass') {
          root.dataset.theme = 'glass';
          root.classList.add('dark', 'theme-glass');
        } else if (stored === 'snow') {
          root.dataset.theme = 'snow';
          root.classList.add('theme-snow');
        } else if (stored === 'light') {
          root.dataset.theme = 'light';
          // already clean
        } else {
          // No stored preference: default is Cream ("light")
          root.dataset.theme = 'light';
        }
      } catch (e) {
        /* localStorage may be disabled */
      }
    })();
  `;

  return (
    <script
      dangerouslySetInnerHTML={{ __html: themeScript }}
      suppressHydrationWarning
    />
  );
}
