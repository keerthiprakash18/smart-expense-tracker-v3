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
  currency = '₹',
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

  const resetScanner = useCallback(() => {
    stopCamera();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl('');
    setSelectedFile(null);
    setResult(EMPTY_RESULT);
    setMode('choose');
    setLoading(false);
    setError('');
    setNotes('Scanned Document');
    setDuplicateMatch(null);
  }, [previewUrl, stopCamera]);

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
    } catch (err) {
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
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(isImage ? URL.createObjectURL(file) : '');
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

  const retake = () => {
    setError('');
    setResult(EMPTY_RESULT);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl('');
    setSelectedFile(null);
    setDuplicateMatch(null);
    setMode('choose');
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
      const enrichedNotes = [notes, ...metadata].filter(Boolean).join(' • ');
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
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl('');
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
    <div style={styles.backdrop}>
      <div style={styles.modal}>
        <div style={styles.header}>
          <div>
            <div style={styles.kicker}>SMART RECEIPT SCANNER</div>
            <h2 style={styles.title}>Scan Receipt</h2>
          </div>
          <button type="button" onClick={onClose} style={styles.iconButton} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        {mode === 'choose' && (
          <div style={styles.chooseGrid}>
            <button type="button" onClick={startCamera} style={styles.optionCard}>
              <div style={styles.optionIcon}><Camera size={30} /></div>
              <strong>Live Camera</strong>
              <span>Open your phone camera and capture the receipt.</span>
            </button>
            <button type="button" onClick={() => fileInputRef.current?.click()} style={styles.optionCard}>
              <div style={styles.optionIcon}><Upload size={30} /></div>
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
            <div style={styles.cameraBox}>
              <video ref={videoRef} autoPlay playsInline muted style={styles.video} />
              <div style={styles.cameraFrame} />
            </div>
            <div style={styles.actionRow}>
              <button type="button" onClick={retake} style={styles.secondary}><X size={17} /> Cancel</button>
              <button type="button" onClick={capturePhoto} style={styles.primary}><Camera size={18} /> Capture</button>
            </div>
          </div>
        )}

        {mode === 'preview' && (
          <div>
            <div style={styles.previewBox}>
              {previewUrl ? <img src={previewUrl} alt="Receipt preview" style={styles.preview} /> : <div style={{padding: 36, textAlign: 'center', color: '#AAB7CA'}}><strong>{selectedFile?.name}</strong><div style={{marginTop: 8, fontSize: 12}}>PDF receipt ready to scan</div></div>}
            </div>
            <div style={styles.actionRow}>
              <button type="button" onClick={retake} style={styles.secondary}><RotateCcw size={17} /> Retake</button>
              <button type="button" onClick={() => scanReceipt()} disabled={loading} style={styles.primary}>
                <ScanLine size={18} /> {loading ? 'Reading receipt…' : 'Scan Again'}
              </button>
            </div>
          </div>
        )}

        {mode === 'result' && (
          <div>
            <div style={styles.success}><CheckCircle2 size={18} /> Receipt scanned automatically. Verify the fields before saving.</div>
            {duplicateMatch && <div style={styles.warning}><AlertTriangle size={16} /> Possible duplicate: {duplicateMatch.title || 'existing transaction'} • {duplicateMatch.date || ''} • {duplicateMatch.amount || ''}</div>}
            <div style={styles.resultMeta}><span style={styles.metaPill}>Confidence <strong>{Math.round(Number(result.confidence?.overall || 0) * 100)}%</strong></span>{result.merchant_memory && <span style={styles.metaPill}>Merchant memory <strong>Matched</strong></span>}{result.tax_amount > 0 && <span style={styles.metaPill}>Tax <strong>{result.tax_amount}</strong></span>}{result.gstin && <span style={styles.metaPill}>GSTIN <strong>{result.gstin}</strong></span>}{result.upi_ref && <span style={styles.metaPill}>UPI Ref <strong>{result.upi_ref}</strong></span>}</div>
            <div style={styles.resultGrid}>
              <label style={styles.label}>Amount<input value={result.amount || ''} onChange={(e) => setResult((p) => ({ ...p, amount: e.target.value }))} inputMode="decimal" style={styles.input} /></label>
              <label style={styles.label}>Transaction Date<input type="date" value={result.date || ''} onChange={(e) => setResult((p) => ({ ...p, date: e.target.value }))} style={styles.input} /></label>
              <label style={styles.label}>Merchant<input value={result.merchant || ''} onChange={(e) => setResult((p) => ({ ...p, merchant: e.target.value }))} style={styles.input} /></label>
              <label style={styles.label}>Category<input value={result.category || 'General'} onChange={(e) => setResult((p) => ({ ...p, category: e.target.value }))} style={styles.input} /></label>
              <label style={styles.label}>Account<select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={styles.input}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name || a.title || 'Account'}</option>)}</select></label>
              <label style={styles.label}>Payment Method<select value={result.payment_method || 'Cash'} onChange={(e) => setResult((p) => ({ ...p, payment_method: e.target.value }))} style={styles.input}><option>Cash</option><option>UPI</option><option>Card</option><option>NetBanking</option></select></label>
              <label style={{ ...styles.label, gridColumn: '1 / -1' }}>Notes<input value={notes} onChange={(e) => setNotes(e.target.value)} style={styles.input} /></label>
            </div>
            {!result.date && <div style={styles.warning}>No reliable date was found in the receipt. Please enter the receipt date manually rather than using today's date.</div>}
            <div style={styles.actionRow}>
              <button type="button" onClick={retake} style={styles.secondary}><RotateCcw size={17} /> Retake</button>
              <button type="button" onClick={confirmExpense} disabled={saving} style={{ ...styles.primary, opacity: saving ? 0.65 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}><CheckCircle2 size={18} /> {saving ? 'Creating Expense…' : 'Confirm & Create Expense'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal: { width: 'min(760px, 100%)', maxHeight: '92vh', overflowY: 'auto', background: '#101116', color: '#fff', border: '1px solid rgba(255,255,255,.10)', borderRadius: 24, padding: 22, boxShadow: '0 30px 100px rgba(0,0,0,.55)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 },
  kicker: { fontSize: 11, fontWeight: 900, letterSpacing: 1.4, opacity: .55 },
  title: { margin: '5px 0 0', fontSize: 25 },
  iconButton: { width: 40, height: 40, borderRadius: 12, border: '1px solid rgba(255,255,255,.10)', background: 'rgba(255,255,255,.05)', color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer' },
  chooseGrid: { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 14 },
  optionCard: { minHeight: 180, borderRadius: 20, border: '1px solid rgba(255,255,255,.10)', background: 'rgba(255,255,255,.04)', color: '#fff', padding: 22, textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10 },
  optionIcon: { width: 58, height: 58, borderRadius: 17, background: 'rgba(10,132,255,.16)', color: '#4aa3ff', display: 'grid', placeItems: 'center' },
  cameraBox: { position: 'relative', width: '100%', aspectRatio: '4/3', background: '#000', borderRadius: 18, overflow: 'hidden' },
  video: { width: '100%', height: '100%', objectFit: 'cover' },
  cameraFrame: { position: 'absolute', inset: '12%', border: '2px solid rgba(255,255,255,.8)', borderRadius: 12, pointerEvents: 'none' },
  previewBox: { width: '100%', maxHeight: '58vh', background: '#000', borderRadius: 18, overflow: 'hidden', display: 'grid', placeItems: 'center' },
  preview: { width: '100%', maxHeight: '58vh', objectFit: 'contain', display: 'block' },
  actionRow: { display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 16 },
  primary: { flex: 1, minHeight: 48, border: 0, borderRadius: 14, background: '#1683ff', color: '#fff', fontWeight: 900, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 },
  secondary: { minHeight: 48, padding: '0 18px', border: '1px solid rgba(255,255,255,.12)', borderRadius: 14, background: 'rgba(255,255,255,.05)', color: '#fff', fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 },
  error: { padding: 12, borderRadius: 12, background: 'rgba(255,69,58,.12)', border: '1px solid rgba(255,69,58,.25)', color: '#ffb4ae', marginBottom: 14, fontSize: 13 },
  success: { padding: 12, borderRadius: 12, background: 'rgba(48,209,88,.10)', border: '1px solid rgba(48,209,88,.22)', color: '#8ff0aa', marginBottom: 14, display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 },
  warning: { marginTop: 12, padding: 12, borderRadius: 12, background: 'rgba(255,159,10,.10)', border: '1px solid rgba(255,159,10,.20)', color: '#ffc86a', fontSize: 12, display:'flex',gap:8,alignItems:'center' },
  resultMeta: { display:'flex',flexWrap:'wrap',gap:8,marginBottom:12 },
  metaPill: { padding:'8px 10px',borderRadius:999,background:'rgba(255,255,255,.05)',border:'1px solid rgba(255,255,255,.08)',color:'#AAB7CA',fontSize:11,display:'inline-flex',gap:5,alignItems:'center' },
  resultGrid: { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 12 },
  label: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, fontWeight: 800, opacity: .9 },
  input: { width: '100%', boxSizing: 'border-box', minHeight: 44, borderRadius: 12, border: '1px solid rgba(255,255,255,.10)', background: '#181a21', color: '#fff', padding: '0 12px', outline: 'none' }
};
