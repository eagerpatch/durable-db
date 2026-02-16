"use client";

import { useState } from "react";

export const ProductForm = () => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("Creating...");

    try {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || undefined,
          priceInCents: Math.round(parseFloat(price) * 100),
        }),
      });

      if (!res.ok) throw new Error(await res.text());

      setName("");
      setDescription("");
      setPrice("");
      setStatus("Product created! Refresh to see it.");
      setTimeout(() => setStatus(null), 2000);
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  };

  return (
    <div className="card">
      <h2>Add Product</h2>
      <form onSubmit={handleSubmit}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <div>
            <label className="text-xs text-muted" style={{ display: "block", marginBottom: "0.25rem" }}>
              Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Widget Pro"
              required
            />
          </div>
          <div>
            <label className="text-xs text-muted" style={{ display: "block", marginBottom: "0.25rem" }}>
              Price ($) *
            </label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="9.99"
              step="0.01"
              min="0.01"
              required
            />
          </div>
        </div>
        <div style={{ marginBottom: "0.75rem" }}>
          <label className="text-xs text-muted" style={{ display: "block", marginBottom: "0.25rem" }}>
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A great product..."
          />
        </div>
        <div className="flex gap-2">
          <button type="submit" className="primary">
            Add Product
          </button>
          {status && <span className="text-sm text-muted">{status}</span>}
        </div>
      </form>
    </div>
  );
};
