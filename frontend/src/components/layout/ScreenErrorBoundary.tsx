import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/** If a screen fails to render, show why instead of a blank page. */
export class ScreenErrorBoundary extends Component<Props, State> {
    state: State = { error: null };
    static getDerivedStateFromError(error: Error): State { return { error }; }
    componentDidCatch(error: Error) { console.error(error); }
    render() {
        if (this.state.error) return <div className="banner bad"><div><strong>This screen could not be shown.</strong><p>{this.state.error.message}</p></div></div>;
        return this.props.children;
    }
}
