(function() {
  // ---------- Theme Logic ----------
  const themeToggle = document.getElementById('themeToggle');
  const htmlElement = document.documentElement;
  
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    htmlElement.setAttribute('data-theme', savedTheme);
    themeToggle.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    htmlElement.setAttribute('data-theme', 'dark');
    themeToggle.textContent = '☀️';
  }

  themeToggle.addEventListener('click', () => {
    const currentTheme = htmlElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    htmlElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    themeToggle.textContent = newTheme === 'dark' ? '☀️' : '🌙';
  });

  // ---------- DOM elements ----------
  const subheadText = document.getElementById('subheadText');
  const statusMsg = document.getElementById('statusMsg');
  const resultCard = document.getElementById('resultCard');
  const responseText = document.getElementById('responseText');

  // Camera elements
  const cameraView = document.getElementById('cameraView');
  const cameraStream = document.getElementById('cameraStream');
  const closeCameraBtn = document.getElementById('closeCameraBtn');
  const captureBtn = document.getElementById('captureBtn');

  // ---------- state ----------
  let currentFile = null;
  let abortController = null;
  let isRequesting = false;
  let mediaStream = null;

  // ---------- constants ----------
  const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const ENDPOINT = 'https://oxford.uk.eu.org/ai/oxford';

  // ---------- helpers ----------
  function setStatus(text, isError = false) {
    statusMsg.innerHTML = '';
    if (text) {
      if (isError) {
        statusMsg.innerHTML = `<span class="error-text" style="background:transparent;padding:0;">⚠️ ${escapeHtml(text)}</span>`;
      } else {
        statusMsg.textContent = text;
      }
    }
  }

  function setLoadingUI(loading, message = '') {
    isRequesting = loading;
    if (loading) {
      statusMsg.innerHTML = `<span class="spinner"></span> ${escapeHtml(message || 'Analyzing shoe…')}`;
    } else {
      if (statusMsg.querySelector('.spinner')) {
        statusMsg.innerHTML = '';
      }
    }
  }

  function escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function clearResult() {
    resultCard.style.display = 'none';
    responseText.textContent = '';
  }

  function showError(message) {
    resultCard.style.display = 'block';
    responseText.innerHTML = `<div class="error-text">${escapeHtml(message)}</div>`;
  }

  // ---------- camera logic ----------
  async function startCamera() {
    try {
      subheadText.textContent = 'Starting camera…';
      setStatus('Starting camera…');
      
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false
      });
      
      cameraStream.srcObject = mediaStream;
      cameraView.style.display = 'flex';
      setStatus('');
      subheadText.textContent = 'Point your camera at the shoes and tap Capture.';
      
    } catch (err) {
      setStatus('❌ Camera access denied or unavailable. Please refresh and allow camera access.', true);
      subheadText.textContent = 'Camera access is required.';
    }
  }

  function stopCamera() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    cameraView.style.display = 'none';
  }

  function capturePhoto() {
    if (!mediaStream) return;

    const canvas = document.createElement('canvas');
    canvas.width = cameraStream.videoWidth || 1280;
    canvas.height = cameraStream.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(cameraStream, 0, 0, canvas.width, canvas.height);
    
    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], 'shoe-capture.jpg', { type: 'image/jpeg' });
        currentFile = file;
        stopCamera();
        subheadText.textContent = 'Image captured! Analyzing shoe…';
        analyzeShoe(); // Automatically trigger scan
      } else {
        setStatus('❌ Failed to capture image.', true);
        stopCamera();
      }
    }, 'image/jpeg', 0.9);
  }

  // ---------- resize to jpeg ----------
  async function resizeImage(file, maxSide = 1280, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width > maxSide || height > maxSide) {
          if (width > height) {
            height = Math.round((height * maxSide) / width);
            width = maxSide;
          } else {
            width = Math.round((width * maxSide) / height);
            height = maxSide;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) reject(new Error('Canvas conversion failed'));
          else resolve(blob);
        }, 'image/jpeg', quality);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not load image'));
      };
      img.src = url;
    });
  }

  // ---------- prompt ----------
  function buildPrompt() {
    return `You are a shoe expert. Analyze the uploaded shoe photo and provide a detailed description in the following format:

1. Description: Describe the shoe's style, color, material, condition, and notable features. **IMPORTANT: This description MUST be a minimum of 20 words. Focus only on the most important visual details.**
2. Brand: Identify the brand if visible/recognizable. If unknown, say "Unknown or unrecognizable".
3. Possible size: Estimate the shoe size (US/UK/EU) based on visual cues. If impossible, say "Cannot determine from photo".
4. Other details: Any other relevant info (e.g., model, release year, rarity).
5. Estimated price (PHP): Give a realistic price range in Philippine Pesos (₱) based on the brand, style, and condition. Use ₱ symbol.

Be concise but informative. Reply with ONLY a valid JSON object, no markdown, no code fences. Use exactly this structure:
{
  "description": "string",
  "brand": "string",
  "possible_size": "string",
  "other_details": "string",
  "estimated_price_php": "string"
}`;
  }

  // ---------- extract json ----------
  function extractJson(text) {
    const t = String(text).replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try {
      return JSON.parse(t.slice(s, e + 1));
    } catch {
      return null;
    }
  }

  // ---------- render result ----------
  function renderResult(apiReply) {
    const parsed = extractJson(apiReply);

    const fields = ['description', 'brand', 'possible_size', 'other_details', 'estimated_price_php'];
    const isValid = parsed && typeof parsed === 'object' &&
      fields.every(f => typeof parsed[f] === 'string');

    if (isValid) {
      responseText.innerHTML = '';

      const grid = document.createElement('div');
      grid.className = 'info-grid';

      const displayFields = [
        { key: 'description', label: '📝 Description' },
        { key: 'brand', label: '🏷️ Brand' },
        { key: 'possible_size', label: '📏 Possible Size' },
        { key: 'other_details', label: '🔍 Other Details' },
        { key: 'estimated_price_php', label: '💰 Estimated Price (PHP)' }
      ];

      displayFields.forEach(({ key, label }) => {
        const item = document.createElement('div');
        item.className = 'info-item';

        const labelEl = document.createElement('div');
        labelEl.className = 'info-label';
        labelEl.textContent = label;

        const valueEl = document.createElement('div');
        valueEl.className = 'info-value';
        valueEl.textContent = parsed[key] || 'Not found';

        item.appendChild(labelEl);
        item.appendChild(valueEl);
        grid.appendChild(item);
      });

      responseText.appendChild(grid);
    } else {
      responseText.textContent = apiReply;
    }

    resultCard.style.display = 'block';
  }

  // ---------- main analyze ----------
  async function analyzeShoe() {
    if (!currentFile) {
      setStatus('No image captured.', true);
      return;
    }
    if (isRequesting) return;

    clearResult();

    let uploadBlob;
    try {
      setLoadingUI(true, 'Preparing image…');
      uploadBlob = await resizeImage(currentFile, 1280, 0.85);
    } catch (err) {
      setLoadingUI(false);
      setStatus('❌ Could not process image.', true);
      subheadText.textContent = 'Error processing image. Please refresh.';
      return;
    }

    const form = new FormData();
    form.append('message', buildPrompt());
    form.append('image', uploadBlob, 'shoe.jpg');

    abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      if (abortController) abortController.abort();
    }, 75000);

    setLoadingUI(true, 'Analyzing shoe… this may take up to 30s');
    subheadText.textContent = 'Analyzing your shoe… Please wait.';

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        body: form,
        signal: abortController.signal
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errorMsg = data.error || `Request failed (HTTP ${res.status})`;
        if (res.status === 403) {
          throw new Error('Available only in the Philippines.');
        } else if (res.status === 413) {
          throw new Error('Image too large. Please use a smaller image.');
        } else if (res.status === 429) {
          const retry = res.headers.get('Retry-After') || 'a minute';
          throw new Error(`Too many requests. Wait ${retry}.`);
        } else if (res.status === 502 || res.status === 503) {
          throw new Error('AI temporarily unavailable. Try again shortly.');
        } else {
          throw new Error(errorMsg);
        }
      }

      if (!data.reply) {
        throw new Error('No reply from AI.');
      }

      renderResult(data.reply);
      setStatus('Analysis complete ✅');
      subheadText.textContent = 'Analysis complete! Refresh the page to scan another shoe.';
    } catch (err) {
      if (err.name === 'AbortError') {
        setStatus('Request timed out or cancelled.', true);
      } else {
        setStatus(err.message || 'Network error. Please try again.', true);
      }
      showError(err.message || 'Network error.');
      subheadText.textContent = 'An error occurred. Please refresh.';
    } finally {
      clearTimeout(timeoutId);
      abortController = null;
      setLoadingUI(false);
    }
  }

  // ---------- events ----------
  closeCameraBtn.addEventListener('click', () => {
    stopCamera();
    subheadText.textContent = 'Camera cancelled. Refresh the page to try again.';
  });

  captureBtn.addEventListener('click', capturePhoto);

  // Start camera automatically on load
  window.addEventListener('load', () => {
    startCamera();
  });

  window.addEventListener('beforeunload', () => {
    stopCamera();
  });
})();