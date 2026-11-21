import { Component, type ErrorInfo, type ReactNode } from 'react'
import { errorText, reportError } from './errors'

interface ErrorBoundaryProps {
  /** Shown in the error card and in the toast, e.g. "plugin mermaid: shape". */
  source: string
  children?: ReactNode
  /** Custom fallback. Inside a three.js Canvas pass `null` (DOM is not allowed there). */
  fallback?: ReactNode | ((message: string, reset: () => void) => ReactNode)
  /** Changing this key clears the error (e.g. after a plugin hot-reloads). */
  resetKey?: string | number
}

interface ErrorBoundaryState {
  message: string | null
  resetKey?: string | number
}

/** Wraps every plugin surface so a broken plugin can never take the app down. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { message: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { message: errorText(error) }
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) return { message: null, resetKey: props.resetKey }
    return null
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportError(this.props.source, `${errorText(error)}${info.componentStack ? `\n${info.componentStack.split('\n').slice(0, 4).join('\n')}` : ''}`)
  }

  private reset = () => this.setState({ message: null })

  render(): ReactNode {
    const { message } = this.state
    if (message === null) return this.props.children
    const { fallback, source } = this.props
    if (typeof fallback === 'function') return fallback(message, this.reset)
    if (fallback !== undefined) return fallback
    return (
      <div className="wb-error-card" role="alert" data-testid="error-card">
        <strong>{source} stopped working</strong>
        <pre>{message}</pre>
        <button type="button" className="wb-button" style={{ marginTop: 8 }} onClick={this.reset}>
          Try again
        </button>
      </div>
    )
  }
}
