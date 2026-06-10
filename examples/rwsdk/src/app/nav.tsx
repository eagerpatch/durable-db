"use client";

export const Nav = () => {
  const search = typeof window !== "undefined" ? window.location.search : "";

  return (
    <nav>
      <a href={`/${search}`}>Home</a>
      <a href={`/products${search}`}>Products</a>
      <a href={`/events${search}`}>Events</a>
    </nav>
  );
};
