import { popover } from '../../utils/uiStore';
import { exportFile, type ExportFormat, type Sheet } from '../../utils/files';

/** Open the Excel / PDF / CSV menu under a button. Sheets are built when a format is chosen. */
export function exportMenu(anchor: HTMLElement, getSheets: () => Sheet[], baseName: string, title?: string): void {
    const pick = (f: ExportFormat) => { popover.close(); exportFile(f, baseName, getSheets(), title); };
    popover.open(anchor, (
        <div>
            <button className="pop-item" onClick={() => pick('xlsx')}>Excel workbook (.xlsx)</button>
            <button className="pop-item" onClick={() => pick('pdf')}>PDF</button>
            <button className="pop-item" onClick={() => pick('csv')}>CSV</button>
        </div>
    ));
}
