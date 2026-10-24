import { Modal, toast } from '../../utils/uiStore';
import { userName } from '../../domain/directory';
import type { UserRecord } from '../../types/enterprise';

/** A temporary password from the server, shown once, for the administrator to pass on. */
export function TempPassword({ user, password, added }: { user: UserRecord; password: string; added?: boolean }) {
    const copy = () => navigator.clipboard.writeText(password).then(() => toast('Password copied'), () => toast('Select the password and copy it'));
    return (
        <div className="temp-pass">
            <div className="temp-pass-head">
                <span className="temp-pass-icon" aria-hidden="true">✓</span>
                <div><b>{added ? `${userName(user)} added` : `New temporary password for ${userName(user)}`}</b><span>{user.email}</span></div>
            </div>
            <div className="temp-pass-box"><code>{password}</code><button type="button" className="btn btn-ghost btn-sm" onClick={copy}>Copy</button></div>
            <div className="temp-pass-warn" role="note"><b>Shown only now.</b> Send it to {userName(user)} securely, not in the same message as the email address. At sign-in they {added ? 'set up an authenticator app and ' : ''}choose their own password.</div>
            <div className="form-actions"><button type="button" className="btn" onClick={() => Modal.close()}>Done</button></div>
        </div>
    );
}
