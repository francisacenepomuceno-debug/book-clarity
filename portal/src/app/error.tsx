"use client";

export default function ErrorPage() {
  return (
    <main className="auth">
      <div className="card">
        <h1>This page isn't available</h1>
        <p>You may not have access to it, or something went wrong. If you think you should see it, ask the Super Admin.</p>
        <p><a href="/">Back to the dashboard</a></p>
      </div>
    </main>
  );
}
