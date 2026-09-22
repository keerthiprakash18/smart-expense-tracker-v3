import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error, info) { console.error('Smart Expense UI error', error, info); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="boot-screen">
      <div className="boot-mark"/>
      <strong>Something went wrong.</strong>
      <span>Your data is safe. Reload the app to continue.</span>
      <button className="button primary" onClick={()=>window.location.reload()}>Reload app</button>
    </div>;
  }
}
