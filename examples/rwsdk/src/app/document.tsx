import { Nav } from "./nav";

export const Document: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Analytics API — @eagerpatch/durable-db + RWSDK</title>
      <link rel="modulepreload" href="/src/client.tsx" />
      <style
        dangerouslySetInnerHTML={{
          __html: `
            *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; line-height: 1.6; }
            a { color: #60a5fa; text-decoration: none; }
            a:hover { text-decoration: underline; }
            .container { max-width: 960px; margin: 0 auto; padding: 2rem; }
            h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.5rem; }
            h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.75rem; color: #d4d4d4; }
            .badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
            .badge-rpc { background: #1e3a5f; color: #93c5fd; }
            .badge-ws { background: #1a3a2a; color: #86efac; }
            table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
            th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #262626; }
            th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #a3a3a3; }
            button, input, textarea, select { font-family: inherit; font-size: 0.875rem; }
            button { cursor: pointer; padding: 0.5rem 1rem; border-radius: 0.375rem; border: 1px solid #404040; background: #171717; color: #e5e5e5; transition: background 0.15s; }
            button:hover { background: #262626; }
            button.primary { background: #2563eb; border-color: #2563eb; color: white; }
            button.primary:hover { background: #1d4ed8; }
            button.green { background: #059669; border-color: #059669; color: white; }
            button.green:hover { background: #047857; }
            input, textarea, select { padding: 0.5rem 0.75rem; border-radius: 0.375rem; border: 1px solid #404040; background: #171717; color: #e5e5e5; width: 100%; }
            input:focus, textarea:focus, select:focus { outline: none; border-color: #2563eb; }
            .card { background: #171717; border: 1px solid #262626; border-radius: 0.5rem; padding: 1.25rem; margin-bottom: 1rem; }
            .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
            .flex { display: flex; align-items: center; }
            .gap-2 { gap: 0.5rem; }
            .gap-4 { gap: 1rem; }
            .mb-2 { margin-bottom: 0.5rem; }
            .mb-4 { margin-bottom: 1rem; }
            .mb-6 { margin-bottom: 1.5rem; }
            .mt-4 { margin-top: 1rem; }
            .text-sm { font-size: 0.875rem; }
            .text-xs { font-size: 0.75rem; }
            .text-muted { color: #a3a3a3; }
            .text-right { text-align: right; }
            nav { display: flex; gap: 1.5rem; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #262626; }
            .info-box { background: #0c1929; border: 1px solid #1e3a5f; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; }
            .info-box.green { background: #0c2918; border-color: #1a3a2a; }
            .mono { font-family: ui-monospace, monospace; font-size: 0.8125rem; }
          `,
        }}
      />
    </head>
    <body>
      <div id="root">
        <div className="container">
          <Nav />
          {children}
        </div>
      </div>
      <script>import("/src/client.tsx")</script>
    </body>
  </html>
);
