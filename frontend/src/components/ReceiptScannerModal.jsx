import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, Upload, RotateCcw, X, ScanLine, CheckCircle2 } from 'lucide-react';
import api from '../services/api';

const EMPTY_RESULT = {
  merchant: '',
  amount: 0,
  category: 'General',
  payment_method: 'Cash',
  date: '',
  currency: 'INR',
  tax_amount: 0,
  gstin: null,
  upi_ref: null,
  confidence: {}
};

function formatDateForInput(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? value : '';
}

export default function ReceiptScannerModal({
  isOpen,
  onClose,
  accounts = [],
  onConfirmExpense
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);

  const [mode, setMode] = useState('choose');
  const [previewUrl, setPreviewUrl] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [result, setResult] = useState(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ? String(accounts[0].id) : '');
  const [notes, setNotes] = useState('Scanned Document');
  const [duplicateMatch, setDuplicateMatch] = useState(null);

  useEffect(() => {
    if (accounts.length && !accountId) {
      setAccountId(String(accounts[0].id));
    }
  }, [accounts, accountId]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const retake = useCallback(() => {
    stopCamera();
    setError('');
    setResult(EMPTY_RESULT);
    setPreviewUrl((url) => {
      if (url) URL.revokeObjectURL(url);
      return '';
    });
    setSelectedFile(null);
    setDuplicateMatch(null);
    setMode('choose');
  }, [stopCamera]);

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      return undefined;
    }
    return () => stopCamera();
  }, [isOpen, stopCamera]);

  const startCamera = async () => {
    setError('');
    stopCamera();

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Live camera is not available in this browser. Use Upload Receipt instead.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      streamRef.current = stream;
      setMode('camera');
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      });
    } catch {
      setError('Camera permission was denied or the camera is unavailable. Please allow camera access or use Upload Receipt.');
      setMode('choose');
    }
  };

  const createPreview = (file) => {
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || file.name?.toLowerCase().endsWith('.pdf');
    const isImage = file.type.startsWith('image/');
    if (!isImage && !isPdf) {
      setError('Please select a receipt image or PDF.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Receipt image must be 10MB or smaller.');
      return;
    }

    stopCamera();
    setPreviewUrl((url) => {
      if (url) URL.revokeObjectURL(url);
      return isImage ? URL.createObjectURL(file) : '';
    });
    setSelectedFile(file);
    setMode('preview');
    setError('');
  };

  const handleFileChange = (event) => {
    const file = event.target.files?.[0];
    if (file) { createPreview(file); scanReceipt(file); }
    event.target.value = '';
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      setError('Camera is not ready yet. Please wait a moment and try again.');
      return;
    }

    const canvas = document.createElement('canvas');
    const maxWidth = 1800;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (!blob) {
        setError('Unable to capture the image. Please try again.');
        return;
      }
      const file = new File([blob], `receipt-${Date.now()}.jpg`, { type: 'image/jpeg' });
      createPreview(file);
      scanReceipt(file);
    }, 'image/jpeg', 0.92);
  };

  const scanReceipt = async (fileOverride = null) => {
    const targetFile = fileOverride || selectedFile;
    if (!targetFile) {
      setError('Please capture or upload a receipt first.');
      return;
    }

    setLoading(true);
    setError('');
    setDuplicateMatch(null);
    try {
      const formData = new FormData();
      formData.append('receipt', targetFile, targetFile.name);

      const response = await api.post('/api/scan-receipt/', formData, {
        timeout: 90000
      });

      const parsed = response.data?.parsed_data || {};
      setResult({
        ...EMPTY_RESULT,
        ...parsed,
        amount: Number(parsed.amount) || 0,
        date: formatDateForInput(parsed.date)
      });
      setDuplicateMatch(response.data?.is_duplicate ? response.data?.duplicate_match || {} : null);
      setMode('result');
    } catch (err) {
      const message = err.response?.data?.detail ? `${err.response?.data?.error || 'Receipt scanning failed.'} ${err.response.data.detail}` : err.response?.data?.error || 'Receipt scanning failed. Please try another clear receipt image.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const confirmExpense = async () => {
    if (saving) return;

    const amount = Number(result.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Please enter a valid amount before confirming.');
      return;
    }

    const cleanDate = String(result.date || '').trim();
    if (!cleanDate) {
      setError('Please enter the receipt date before confirming.');
      return;
    }

    const account = accountId || accounts[0]?.id || '';
    if (!account) {
      setError('Please select an account before confirming.');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const metadata = [
        result.tax_amount ? `Tax: ${result.tax_amount}` : '',
        result.gstin ? `GSTIN: ${result.gstin}` : '',
        result.upi_ref ? `UPI Ref: ${result.upi_ref}` : ''
      ].filter(Boolean);
      const enrichedNotes = [notes, ...metadata].filter(Boolean).join(' â€¢ ');
      const confidence = Math.round(Number(result.confidence?.overall || 0) * 100);
      const success = await onConfirmExpense?.({
        title: result.merchant || 'Scanned Receipt',
        amount,
        transaction_type: 'EXPENSE',
        category: result.category || 'General',
        account,
        payment_method: result.payment_method || 'Cash',
        date: cleanDate,
        notes: enrichedNotes,
        receipt_image: selectedFile,
        ocr_confidence: confidence || null
      });

      if (success === false) {
        setError('Unable to create the expense. Please check the account, date and amount.');
        return;
      }

      stopCamera();
      setPreviewUrl((url) => {
        if (url) URL.revokeObjectURL(url);
        return '';
      });
      setSelectedFile(null);
      setResult(EMPTY_RESULT);
      setMode('choose');
      setNotes('Scanned Document');
      setDuplicateMatch(null);
      onClose?.();
    } catch (err) {
      setError(err?.message || 'Unable to create the expense.');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop scanner-backdrop">
      <div className="modal-card scanner-card">
        <div className="modal-head">
          <div>
            <span>SMART RECEIPT SCANNER</span>
            <h2>Scan Receipt</h2>
          </div>
          <button type="button" onClick={onClose} className="icon-button" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {error && <div className="alert error">{error}</div>}

        {mode === 'choose' && (
          <div className="scanner-choose">
            <button type="button" onClick={startCamera} className="scanner-option">
              <div className="scanner-option-icon"><Camera size={30} /></div>
              <strong>Live Camera</strong>
              <span>Open your phone camera and capture the receipt.</span>
            </button>
            <button type="button" onClick={() => fileInputRef.current?.click()} className="scanner-option">
              <div className="scanner-option-icon"><Upload size={30} /></div>
              <strong>Upload Receipt</strong>
              <span>Choose a receipt image from your phone or computer.</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
          </div>
        )}

        {mode === 'camera' && (
          <div>
            <div className="scanner-camera">
              <video ref={videoRef} autoPlay playsInline muted className="scanner-video" />
              <div className="scanner-frame" />
            </div>
            <div className="scanner-actions">
              <button type="button" onClick={retake} className="button ghost"><X size={17} /> Cancel</button>
              <button type="button" onClick={capturePhoto} className="button primary"><Camera size={18} /> Capture</button>
            </div>
          </div>
        )}

        {mode === 'preview' && (
          <div>
            <div className="scanner-preview">
              {previewUrl ? <img src={previewUrl} alt="Receipt preview" className="scanner-preview-img" /> : <div className="scanner-pdf-placeholder"><strong>{selectedFile?.name}</strong><div>PDF receipt ready to scan</div></div>}
            </div>
            <div className="scanner-actions">
              <button type="button" onClick={retake} className="button ghost"><RotateCcw size={17} /> Retake</button>
              <button type="button" onClick={() => scanReceipt()} disabled={loading} className="button primary">
                <ScanLine size={18} /> {loading ? 'Reading receiptâ€¦' : 'Scan Again'}
              </button>
            </div>
          </div>
        )}

        {mode === 'result' && (
          <div>
            <div className="alert success"><CheckCircle2 size={18} /> Receipt scanned automatically. Verify the fields before saving.</div>
            {duplicateMatch && <div className="alert warning"><AlertTriangle size={16} /> Possible duplicate: {duplicateMatch.title || 'existing transaction'} â€¢ {duplicateMatch.date || ''} â€¢ {duplicateMatch.amount || ''}</div>}
            <div className="scanner-meta">
              <span className="meta-pill">Confidence <strong>{Math.round(Number(result.confidence?.overall || 0) * 100)}%</strong></span>
              {result.merchant_memory && <span className="meta-pill">Merchant memory <strong>Matched</strong></span>}
              {result.ai_category && !result.merchant_memory && <span className="meta-pill">AI <strong>{result.ai_category} · {Math.round(Number(result.ai_confidence || 0) * 100)}%</strong></span>}
              {result.tax_amount > 0 && <span className="meta-pill">Tax <strong>{result.tax_amount}</strong></span>}
              {result.gstin && <span className="meta-pill">GSTIN <strong>{result.gstin}</strong></span>}
              {result.upi_ref && <span className="meta-pill">UPI Ref <strong>{result.upi_ref}</strong></span>}
            </div>
            {result.category_alternatives && <div className="alert info scanner-alt">
              <span>OCR read <strong>{result.category_alternatives.ocr}</strong>; your model suggested <strong>{result.category_alternatives.model}</strong> ({Math.round(Number(result.category_alternatives.model_confidence || 0) * 100)}%). Pick the right one below.</span>
            </div>}
            <div className="scanner-grid">
              <label><span>Amount</span><input value={result.amount || ''} onChange={(e) => setResult((p) => ({ ...p, amount: e.target.value }))} inputMode="decimal" /></label>
              <label><span>Transaction Date</span><input type="date" value={result.date || ''} onChange={(e) => setResult((p) => ({ ...p, date: e.target.value }))} /></label>
              <label><span>Merchant</span><input value={result.merchant || ''} onChange={(e) => setResult((p) => ({ ...p, merchant: e.target.value }))} /></label>
              <label><span>Category</span><input value={result.category || 'General'} onChange={(e) => setResult((p) => ({ ...p, category: e.target.value }))} /></label>
              <label><span>Account</span><select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name || a.title || 'Account'}</option>)}</select></label>
              <label><span>Payment Method</span><select value={result.payment_method || 'Cash'} onChange={(e) => setResult((p) => ({ ...p, payment_method: e.target.value }))}><option>Cash</option><option>UPI</option><option>Card</option><option>NetBanking</option></select></label>
              <label className="scanner-full"><span>Notes</span><input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            </div>
            {!result.date && <div className="alert warning">No reliable date was found in the receipt. Please enter the receipt date manually rather than using today's date.</div>}
            <div className="scanner-actions">
              <button type="button" onClick={retake} className="button ghost"><RotateCcw size={17} /> Retake</button>
              <button type="button" onClick={confirmExpense} disabled={saving} className="button primary"><CheckCircle2 size={18} /> {saving ? 'Creating Expenseâ€¦' : 'Confirm & Create Expense'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
