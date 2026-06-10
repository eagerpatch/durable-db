export const Home = () => {
  return (
    <div>
      <h1>Multi-tenant Analytics API</h1>
      <p className="text-muted mb-6">
        A demo of <code className="mono">durable-db</code> with RWSDK,
        showing two databases with different transports.
      </p>

      <div className="grid-2">
        <div className="card">
          <div className="flex gap-2 mb-2">
            <h2>Products</h2>
            <span className="badge badge-rpc">RPC</span>
          </div>
          <p className="text-sm text-muted mb-4">
            Product catalog using the default RPC transport. Low-volume CRUD
            operations where standard billing works great.
          </p>
          <a href="/products">
            <button className="primary">Manage Products</button>
          </a>
        </div>

        <div className="card">
          <div className="flex gap-2 mb-2">
            <h2>Events</h2>
            <span className="badge badge-ws">WebSocket</span>
          </div>
          <p className="text-sm text-muted mb-4">
            Analytics event ingestion using WebSocket transport. High-volume
            writes benefit from the 20:1 billing ratio.
          </p>
          <a href="/events">
            <button className="green">View Analytics</button>
          </a>
        </div>
      </div>

      <div className="card mt-4">
        <h2>How it works</h2>
        <p className="text-sm text-muted mb-2">
          This example uses two separate Durable Object databases:
        </p>
        <ul
          style={{
            listStyle: "disc",
            paddingLeft: "1.5rem",
            fontSize: "0.875rem",
            color: "#a3a3a3",
          }}
        >
          <li>
            <strong style={{ color: "#e5e5e5" }}>main</strong> — Products
            catalog with standard RPC transport (1:1 billing)
          </li>
          <li>
            <strong style={{ color: "#e5e5e5" }}>events</strong> — Analytics
            events with WebSocket transport (20:1 billing — up to 20x cheaper
            for high-volume calls)
          </li>
        </ul>
        <p className="text-sm text-muted mt-4">
          Tenant isolation is handled via the{" "}
          <code className="mono">X-Tenant-ID</code> header or{" "}
          <code className="mono">?tenant=</code> query parameter. Each tenant
          gets its own Durable Object instance per database.
        </p>
      </div>
    </div>
  );
};
