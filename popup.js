console.log('Hello from content script!');
fetch(chrome.runtime.getURL('popup/popup.html'))
    .then(response => response.text())
    .then(html => {
        document.documentElement.innerHTML = html.replace('${domain}', window.location.hostname);
        console.log('Injecting script');
        executeScript();
    });

function executeScript() {
    console.log('Executing script');

    // Global settings variables
    let settings = {
        loop: true,
        autoplay: true,
        mute: true,
        volume: 0.5,
        playbackRate: 1.0
    };

    // Synchronization system
    let syncInterval = null;
    let lastSyncTime = 0;
    const SYNC_INTERVAL_MS = 1000;

    // Timestamp persistence functions
    function saveVideoTimestamp(currentTime, callback) {
        openDB().then(db => {
            const transaction = db.transaction(['state', 'hashes'], 'readwrite');
            const store = transaction.objectStore('state');
            const hashStore = transaction.objectStore('hashes');

            const timestampData = {
                currentTime: currentTime,
                savedAt: Date.now(),
                videoHash: null
            };

            const hashRequest = hashStore.get('videoHash');

            hashRequest.onsuccess = (event) => {
                timestampData.videoHash = event.target.result;
                store.put(timestampData, 'videoTimestamp');
            };

            transaction.oncomplete = () => {
                console.log(`[VirtualCamera] Timestamp saved: ${currentTime}s`);
                callback && callback();
            };
            transaction.onerror = (event) => {
                console.warn('[VirtualCamera] Timestamp save transaction error:', event.target.error);
            };
        }).catch(error => {
            console.warn('[VirtualCamera] Timestamp save error:', error);
        });
    }

    function loadVideoTimestamp(callback) {
        openDB().then(db => {
            const transaction = db.transaction(['state', 'hashes'], 'readonly');
            const timestampStore = transaction.objectStore('state');
            const hashStore = transaction.objectStore('hashes');

            const timestampRequest = timestampStore.get('videoTimestamp');
            const currentHashRequest = hashStore.get('videoHash');

            Promise.all([
                new Promise(resolve => {
                    timestampRequest.onsuccess = (event) => resolve(event.target.result);
                    timestampRequest.onerror = () => resolve(null);
                }),
                new Promise(resolve => {
                    currentHashRequest.onsuccess = (event) => resolve(event.target.result);
                    currentHashRequest.onerror = () => resolve(null);
                })
            ]).then(([timestampData, currentHash]) => {
                if (!timestampData || !currentHash) {
                    callback && callback(null);
                    return;
                }

                if (timestampData.videoHash !== currentHash) {
                    console.log('[VirtualCamera] Different hash, timestamp ignored');
                    callback && callback(null);
                    return;
                }

                const timeSinceSave = (Date.now() - timestampData.savedAt) / 1000;
                let adjustedTime = timestampData.currentTime;

                adjustedTime += timeSinceSave;
                if (settings.loop && videoElement && videoElement.duration) {
                    adjustedTime = adjustedTime % videoElement.duration;
                }
                console.log(`[VirtualCamera] Estimated time after ${timeSinceSave.toFixed(1)}s: ${adjustedTime.toFixed(1)}s`);

                callback && callback({
                    currentTime: adjustedTime,
                    savedAt: timestampData.savedAt,
                    timeSinceSave: timeSinceSave
                });
            });
        }).catch(error => {
            console.warn('[VirtualCamera] Timestamp load error:', error);
            callback && callback(null);
        });
    }

    function clearVideoTimestamp() {
        openDB().then(db => {
            const transaction = db.transaction(['state'], 'readwrite');
            transaction.objectStore('state').delete('videoTimestamp');
        }).catch(console.warn);
    }

    function autoSaveTimestamp(videoElement) {
        if (!videoElement || !videoElement.src) return;
        if (!videoElement.paused && videoElement.currentTime > 0) {
            saveVideoTimestamp(videoElement.currentTime);
        }
    }

    function startVideoSync(videoElement) {
        if (syncInterval) return;

        syncInterval = setInterval(() => {
            if (videoElement && !videoElement.paused) {
                const currentTime = videoElement.currentTime;
                const elapsed = Date.now() - lastSyncTime;

                if (elapsed >= SYNC_INTERVAL_MS) {
                    channel.postMessage({
                        type: 'VIRTUAL_CAMERA_CONTROL',
                        command: 'sync',
                        time: currentTime
                    });
                    lastSyncTime = Date.now();
                }

                if (Math.floor(currentTime) % 10 === 0) {
                    autoSaveTimestamp(videoElement);
                }
            }
        }, SYNC_INTERVAL_MS);
    }

    function stopVideoSync() {
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
            lastSyncTime = 0;
        }
    }

    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('virtualCameraDB', 2);
            request.onupgradeneeded = function(event) {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos');
                if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
                if (!db.objectStoreNames.contains('hashes')) db.createObjectStore('hashes');
            };
            request.onsuccess = function(event) { resolve(event.target.result); };
            request.onerror = function(event) { reject(event.target.error); };
        });
    }

    function saveVideoToIndexedDB(file, videoElement, callback) {
        if (!file.type.startsWith('video/')) {
            showNotification('Veuillez sélectionner un fichier vidéo', 'error');
            return;
        }

        showLoading(true);

        openDB().then(async db => {
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const buffer = e.target.result;
                    const hash = await computeHash(buffer);
                    const transaction = db.transaction(['videos', 'hashes'], 'readwrite');
                    transaction.objectStore('videos').put(buffer, 'video');
                    transaction.objectStore('hashes').put(hash, 'videoHash');
                    transaction.oncomplete = () => {
                        const blob = new Blob([buffer], { type: file.type });
                        videoElement.src = URL.createObjectURL(blob);
                        videoElement.muted = settings.mute;
                        videoElement.volume = settings.mute ? 0 : settings.volume;
                        videoElement.loop = settings.loop;
                        hideVideoOverlay();
                        showNotification('Vidéo chargée avec succès', 'success');
                        showLoading(false);
                        callback && callback();
                    };
                } catch (error) {
                    console.warn('Error while saving:', error);
                    showNotification('Erreur lors du chargement', 'error');
                    showLoading(false);
                }
            };
            reader.readAsArrayBuffer(file);
        });
    }

    function loadVideoFromIndexedDB(videoElement, callback) {
        openDB().then(db => {
            const transaction = db.transaction(['videos'], 'readonly');
            const store = transaction.objectStore('videos');
            const request = store.get('video');

            request.onsuccess = function(event) {
                if (event.target.result) {
                    const blob = new Blob([event.target.result]);
                    videoElement.src = URL.createObjectURL(blob);
                    videoElement.muted = settings.mute;
                    videoElement.volume = settings.mute ? 0 : settings.volume;
                    videoElement.loop = settings.loop;

                    videoElement.addEventListener('loadedmetadata', () => {
                        loadVideoTimestamp((timestampData) => {
                            if (timestampData && timestampData.currentTime > 0) {
                                const targetTime = Math.min(timestampData.currentTime, videoElement.duration);
                                videoElement.currentTime = targetTime;

                                const timeInfo = timestampData.timeSinceSave < 60
                                    ? `il y a ${Math.round(timestampData.timeSinceSave)}s`
                                    : `il y a ${Math.round(timestampData.timeSinceSave / 60)} min`;

                                showNotification(
                                    `Vidéo reprise à ${Math.round(targetTime)}s (sauvegardée ${timeInfo})`,
                                    'info'
                                );
                            }
                        });
                    }, { once: true });

                    hideVideoOverlay();
                    callback && callback(true);
                } else {
                    showVideoOverlay();
                    callback && callback(false);
                }
            };
            request.onerror = function() { callback && callback(false); };
        });
    }

    function saveVirtualCameraState(isOn, callback) {
        openDB().then(db => {
            const transaction = db.transaction(['state'], 'readwrite');
            transaction.objectStore('state').put(isOn, 'virtualCameraOn');
            transaction.oncomplete = () => callback && callback();
        });
    }

    function loadVirtualCameraState(callback) {
        openDB().then(db => {
            const transaction = db.transaction(['state'], 'readonly');
            const store = transaction.objectStore('state');
            const request = store.get('virtualCameraOn');
            request.onsuccess = function(event) { callback(!!event.target.result); };
            request.onerror = function() { callback(false); };
        });
    }

    function setVirtualCameraState(isOn, videoElement, toggleButton) {
        saveVirtualCameraState(isOn, () => {
            updateToggleButton(toggleButton, isOn);
            updateStatusIndicator(isOn);
        });
    }

    function updateToggleButton(toggleButton, isOn) {
        const span = toggleButton.querySelector('span');
        const text = toggleButton.childNodes[toggleButton.childNodes.length - 1];

        if (isOn) {
            toggleButton.classList.add('active');
            if (span) span.textContent = '⏹️';
            if (text) text.textContent = ' Désactiver la caméra';
        } else {
            toggleButton.classList.remove('active');
            if (span) span.textContent = '▶️';
            if (text) text.textContent = ' Activer la caméra';
        }
    }

    function updateStatusIndicator(active) {
        const statusDot = document.getElementById('status-dot');
        const statusText = document.getElementById('status-text');

        if (statusDot) {
            statusDot.classList.toggle('active', active);
        }
        if (statusText) {
            statusText.textContent = active ? 'Active' : 'Inactive';
        }
    }

    async function computeHash(buffer) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function hideVideoOverlay() {
        const overlay = document.getElementById('video-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }
    }

    function showVideoOverlay() {
        const overlay = document.getElementById('video-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
        }
    }

    function showNotification(message, type = 'info') {
        console.log(`[VirtualCamera] ${type.toUpperCase()}: ${message}`);
        createToast(message, type);
    }

    function createToast(message, type) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;

        Object.assign(toast.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            padding: '12px 20px',
            borderRadius: '12px',
            color: 'white',
            fontSize: '14px',
            fontWeight: '500',
            zIndex: '10000',
            transform: 'translateX(100%)',
            transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            backgroundColor: type === 'success' ? '#10b981' :
                           type === 'error' ? '#ef4444' : '#667eea',
            boxShadow: '0 8px 16px rgba(0,0,0,0.15)'
        });

        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.transform = 'translateX(0)';
        }, 100);

        setTimeout(() => {
            toast.style.transform = 'translateX(100%)';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, 3000);
    }

    function showLoading(show) {
        const toggleButton = document.getElementById('toggle-button');
        if (toggleButton) {
            toggleButton.disabled = show;
            toggleButton.style.opacity = show ? '0.6' : '1';
        }
    }

    function setupToggleSwitch(elementId, settingName) {
        const element = document.getElementById(elementId);
        if (!element) return;

        element.classList.toggle('active', settings[settingName]);

        element.addEventListener('click', () => {
            settings[settingName] = !settings[settingName];
            element.classList.toggle('active', settings[settingName]);
            applyVideoSettings();

            const displayName = {
                loop: 'Lecture en boucle',
                autoplay: 'Lecture automatique',
                mute: 'Muet'
            }[settingName] || settingName;

            showNotification(`${displayName} ${settings[settingName] ? 'activée' : 'désactivée'}`, 'info');
        });
    }

    function applyVideoSettings() {
        const videoElement = document.getElementById('video');
        if (!videoElement) return;

        videoElement.loop = settings.loop;
        videoElement.muted = settings.mute;
        videoElement.volume = settings.mute ? 0 : settings.volume;

        if (settings.autoplay && videoElement.src && videoElement.paused) {
            videoElement.play().catch(console.warn);
        }
    }

    function setupDragAndDrop() {
        const videoSection = document.querySelector('.video-section');
        if (!videoSection) return;

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            videoSection.addEventListener(eventName, preventDefaults, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            videoSection.addEventListener(eventName, highlight, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            videoSection.addEventListener(eventName, unhighlight, false);
        });

        videoSection.addEventListener('drop', handleDrop, false);

        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }

        function highlight() {
            videoSection.style.boxShadow = '0 0 20px rgba(102,126,234,0.5)';
            videoSection.style.transform = 'scale(1.02)';
        }

        function unhighlight() {
            videoSection.style.boxShadow = '';
            videoSection.style.transform = '';
        }

        function handleDrop(e) {
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                const videoElement = document.getElementById('video');
                const toggleButton = document.getElementById('toggle-button');
                saveVideoToIndexedDB(files[0], videoElement, () => {
                    toggleButton.disabled = false;
                    channel.postMessage({ type: 'VIRTUAL_CAMERA_CONTROL', command: 'sourceChanged' });
                });
            }
        }
    }

    const toggleButton = document.getElementById('toggle-button');
    const videoElement = document.getElementById('video');
    const videoUpload = document.getElementById('video-upload');
    const clearDbBtn = document.getElementById('clear-db-btn');
    const channel = new BroadcastChannel('virtual_camera_channel');
    let isOn = false;

    setupDragAndDrop();

    if (videoElement) {
        videoElement.addEventListener('loadedmetadata', () => {
            console.log(`[VirtualCamera] Video: ${videoElement.videoWidth}x${videoElement.videoHeight}, duration: ${videoElement.duration}s`);
            applyVideoSettings();
        });

        videoElement.addEventListener('timeupdate', () => {
            if (!videoElement.paused && Math.floor(videoElement.currentTime) % 5 === 0) {
                autoSaveTimestamp(videoElement);
            }
        });

        videoElement.addEventListener('seeked', () => {
            saveVideoTimestamp(videoElement.currentTime);
            channel.postMessage({
                type: 'VIRTUAL_CAMERA_CONTROL',
                command: 'seek',
                time: videoElement.currentTime
            });
            lastSyncTime = Date.now();
        });

        // Ecoute play/pause quelle que soit la source (clic vidéo, barre de lecture, espace)
        videoElement.addEventListener('pause', () => {
            saveVideoTimestamp(videoElement.currentTime);
            channel.postMessage({ type: 'VIRTUAL_CAMERA_CONTROL', command: 'pause' });
            stopVideoSync();
        });

        videoElement.addEventListener('play', () => {
            channel.postMessage({ type: 'VIRTUAL_CAMERA_CONTROL', command: 'play' });
            startVideoSync(videoElement);
        });

        videoElement.addEventListener('emptied', () => {
            stopVideoSync();
        });
    }

    if (videoUpload) {
        videoUpload.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                saveVideoToIndexedDB(file, videoElement, () => {
                    toggleButton.disabled = false;
                    channel.postMessage({ type: 'VIRTUAL_CAMERA_CONTROL', command: 'sourceChanged' });
                });
            }
        });
    }

    const fileWrapper = document.querySelector('#video-upload-btn');
    if (fileWrapper && videoUpload) {
        fileWrapper.addEventListener('click', () => {
            videoUpload.click();
        });
    }

    loadVideoFromIndexedDB(videoElement, (hasVideo) => {
        loadVirtualCameraState((state) => {
            isOn = !!state;
            setVirtualCameraState(isOn, videoElement, toggleButton);
            if (!hasVideo) {
                toggleButton.disabled = true;
                showVideoOverlay();
            } else {
                hideVideoOverlay();
            }
        });
    });

    if (toggleButton) {
        toggleButton.addEventListener('click', () => {
            if (!videoElement.src) {
                showNotification("Veuillez d'abord charger une vidéo", 'error');
                return;
            }
            isOn = !isOn;
            setVirtualCameraState(isOn, videoElement, toggleButton);

            if (isOn) {
                loadVideoTimestamp((timestampData) => {
                    if (timestampData && timestampData.currentTime > 0) {
                        videoElement.currentTime = Math.min(timestampData.currentTime, videoElement.duration);
                    }
                    videoElement.play();
                    startVideoSync(videoElement);
                });

                channel.postMessage({ type: 'VIRTUAL_CAMERA_CONTROL', command: 'turnOn' });
                showNotification('Caméra virtuelle activée', 'success');
            } else {
                saveVideoTimestamp(videoElement.currentTime);
                videoElement.pause();
                videoElement.currentTime = 0;
                clearVideoTimestamp();
                stopVideoSync();
                channel.postMessage({ type: 'VIRTUAL_CAMERA_CONTROL', command: 'turnOff' });
                showNotification('Caméra virtuelle désactivée', 'info');
            }
        });
    }

    if (clearDbBtn) {
        clearDbBtn.onclick = async () => {
            if (!confirm('Êtes-vous sûr de vouloir tout effacer ?')) {
                return;
            }

            try {
                showLoading(true);
                const db = await openDB();

                const transaction = db.transaction(['videos', 'hashes', 'state'], 'readwrite');
                transaction.objectStore('videos').clear();
                transaction.objectStore('hashes').clear();
                transaction.objectStore('state').clear();

                transaction.oncomplete = () => {
                    showNotification('Toutes les données ont été effacées', 'success');
                    setTimeout(() => {
                        location.reload();
                    }, 1000);
                };
            } catch (error) {
                console.warn('Error while erasing:', error);
                showNotification("Erreur lors de l'effacement", 'error');
                showLoading(false);
            }
        };
    }

    setTimeout(() => {
        document.body.classList.add('fade-in');
    }, 100);

    window.addEventListener('beforeunload', () => {
        console.log('[VirtualCamera] Saving before closing...');

        if (videoElement && videoElement.src && videoElement.currentTime > 0) {
            saveVideoTimestamp(videoElement.currentTime, () => {
                console.log('[VirtualCamera] Timestamp saved before closing');
            });
        }

        stopVideoSync();

        if (videoElement && videoElement.src.startsWith('blob:')) {
            URL.revokeObjectURL(videoElement.src);
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && videoElement && videoElement.currentTime > 0) {
            saveVideoTimestamp(videoElement.currentTime);
            console.log('[VirtualCamera] Timestamp saved (tab hidden)');
        }
    });
}