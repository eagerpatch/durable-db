import { getEventCounts } from "../../databases/actions/getEventCounts";
import { EventControls } from "./eventControls";

export const Events = async () => {
  const counts = await getEventCounts({});

  const totalEvents = counts.reduce(
    (sum: number, row: any) => sum + (row.count ?? 0),
    0,
  );

  return (
    <div>
      <div className="flex gap-2 mb-2">
        <h1>Analytics Events</h1>
        <span className="badge badge-ws">WebSocket Transport</span>
      </div>
      <p className="text-muted mb-4">
        Event ingestion stored in the <code className="mono">events</code>{" "}
        database using WebSocket transport.
      </p>

      <div className="info-box green mb-4">
        <p className="text-sm">
          <strong>WebSocket transport:</strong> With a persistent connection, up
          to 20 messages count as 1 billable request (20:1 ratio). For
          high-volume event ingestion, this is up to{" "}
          <strong>20x cheaper</strong> than standard RPC.
        </p>
      </div>

      <EventControls />

      <h2 className="mt-4">Event Counts by Type</h2>
      <p className="text-sm text-muted mb-2">
        Total events tracked: <strong>{totalEvents}</strong>
      </p>

      {counts.length === 0 ? (
        <p className="text-sm text-muted mt-4">
          No events tracked yet. Fire some events above!
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Event Type</th>
              <th className="text-right">Count</th>
            </tr>
          </thead>
          <tbody>
            {counts.map((row: any) => (
              <tr key={row.type}>
                <td>
                  <code className="mono">{row.type}</code>
                </td>
                <td className="text-right mono">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
