"use client";

import { useState } from "react";

const EVENT_TYPES = [
  "page_view",
  "add_to_cart",
  "checkout_start",
  "purchase",
  "product_click",
];

export const EventControls = () => {
  const [selectedType, setSelectedType] = useState(EVENT_TYPES[0]);
  const [status, setStatus] = useState<string | null>(null);
  const [batchSize, setBatchSize] = useState("10");

  const sessionId = "session-" + Math.random().toString(36).slice(2, 8);

  const fireEvent = async () => {
    setStatus("Tracking...");
    try {
      const res = await fetch(`/api/events${window.location.search}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selectedType,
          sessionId,
          payload: JSON.stringify({ timestamp: Date.now() }),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setStatus(`Tracked 1 "${selectedType}" event. Refresh to see counts.`);
      setTimeout(() => setStatus(null), 2000);
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  };

  const fireBatch = async () => {
    const size = parseInt(batchSize) || 10;
    setStatus(`Tracking ${size} events...`);
    try {
      const events = Array.from({ length: size }, (_, i) => ({
        type: EVENT_TYPES[i % EVENT_TYPES.length],
        sessionId,
        payload: JSON.stringify({ index: i, timestamp: Date.now() }),
      }));

      const res = await fetch(`/api/events/batch${window.location.search}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      setStatus(
        `Batch tracked ${result.inserted} events via WebSocket! Refresh to see counts.`,
      );
      setTimeout(() => setStatus(null), 3000);
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  };

  return (
    <div className="card">
      <h2>Fire Events</h2>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "1rem",
        }}
      >
        <div>
          <label
            className="text-xs text-muted"
            style={{ display: "block", marginBottom: "0.25rem" }}
          >
            Single Event
          </label>
          <div className="flex gap-2">
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              style={{
                padding: "0.5rem 0.75rem",
                borderRadius: "0.375rem",
                border: "1px solid #404040",
                background: "#171717",
                color: "#e5e5e5",
                fontSize: "0.875rem",
              }}
            >
              {EVENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <button onClick={fireEvent} className="green">
              Track Event
            </button>
          </div>
        </div>

        <div>
          <label
            className="text-xs text-muted"
            style={{ display: "block", marginBottom: "0.25rem" }}
          >
            Batch Events (demonstrates WebSocket value)
          </label>
          <div className="flex gap-2">
            <input
              type="number"
              value={batchSize}
              onChange={(e) => setBatchSize(e.target.value)}
              min="1"
              max="100"
              style={{ width: "5rem" }}
            />
            <button onClick={fireBatch} className="green">
              Batch Track
            </button>
          </div>
        </div>
      </div>

      {status && (
        <p className="text-sm mt-4" style={{ color: "#86efac" }}>
          {status}
        </p>
      )}
    </div>
  );
};
