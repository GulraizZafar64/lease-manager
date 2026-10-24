import type { ReactNode } from 'react';
import { Modal } from '../../utils/uiStore';

interface ConfirmBodyProps { message: ReactNode; confirmLabel: string; danger: boolean; onConfirm: () => void }

function ConfirmBody({ message, confirmLabel, danger, onConfirm }: ConfirmBodyProps) {
    return (
        <>
            <p>{message}</p>
            <div className="form-actions">
                <button className="btn btn-ghost" onClick={() => Modal.close()}>Cancel</button>
                <button className={`btn ${danger ? 'btn-danger' : ''}`} onClick={() => { Modal.close(); onConfirm(); }}>{confirmLabel}</button>
            </div>
        </>
    );
}

export function confirmDialog(title: string, message: ReactNode, confirmLabel: string, onConfirm: () => void, danger = true): void {
    Modal.open(title, <ConfirmBody message={message} confirmLabel={confirmLabel} danger={danger} onConfirm={onConfirm} />);
}
