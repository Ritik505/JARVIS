document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const chatLog = document.getElementById('chat-log');
    const aiCore = document.getElementById('ai-core');
    const micIcon = document.getElementById('mic-icon');
    const statusDisplay = document.getElementById('status-display');
    const langButtons = document.querySelectorAll('.lang-btn');
    const visualizerCanvas = document.getElementById('visualizer');


    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

    // Current Gemini model.
    // Google currently documents gemini-3.5-flash for GenerateContent.
    const GEMINI_MODEL = 'gemini-3.5-flash';

    // API URL without the API key in the query string.
    const GOOGLE_API_URL =
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    // --- State Management ---
    const state = {
        current: 'IDLE',
        selectedLanguage: 'Hinglish',
        wasInterrupted: false,
        conversationHistory: [],
    };

    let recognition;
    let isRecognitionActive = false;

    // Prevent duplicate Gemini requests.
    let isGeminiRequestActive = false;

    // --- Audio Visualizer ---
    let audioContext;
    let analyser;
    let source;
    let dataArray;
    let animationFrameId;

    const canvasCtx = visualizerCanvas.getContext('2d');

    // --- System Prompts ---
    const systemPrompts = {
        "English":
            "You are J.A.R.V.I.S., a hyper-intelligent AI assistant created by Ritik Verma. " +
            "Your primary function is to provide accurate, factual, and concise information. " +
            "Your persona is sophisticated, calm, and incredibly capable. " +
            "Prioritize correctness above all. " +
            "If you don't know an answer, state that you lack the data. " +
            "Never mention you are an AI model. " +
            "Address the user as 'Sir'. " +
            "Keep responses brief and to the point.",

        "Hindi":
            "आप J.A.R.V.I.S. हैं, एक अत्यधिक बुद्धिमान AI, जिसे ऋतिक वर्मा ने बनाया है। " +
            "आपका मुख्य कार्य सटीक, तथ्यात्मक और संक्षिप्त जानकारी देना है। " +
            "हमेशा शुद्धता को प्राथमिकता दें। " +
            "यदि आप कोई उत्तर नहीं जानते हैं, तो कहें कि डेटा उपलब्ध नहीं है। " +
            "हमेशा 'सर' के रूप में संबोधित करें और उत्तर संक्षिप्त रखें।",

        "Hinglish":
            "You are J.A.R.V.I.S., a hyper-intelligent AI built by Ritik Verma. " +
            "Sir, your goal is to provide accurate and short answers. " +
            "Always be direct and to-the-point. " +
            "Agar koi information nahi hai, toh clearly bolo 'Sir, I don't have that information'. " +
            "Apni capabilities confidently state karo. " +
            "Hamesha 'Sir' address karo."
    };

    // --- State Machine ---
    function updateState(newState) {
        state.current = newState;

        aiCore.className = 'ai-core';
        aiCore.classList.add(`state-${newState.toLowerCase()}`);

        statusDisplay.textContent = newState;

        switch (newState) {
            case 'IDLE':
                micIcon.className = 'fa-solid fa-microphone';
                stopVisualizer();
                break;

            case 'LISTENING':
                micIcon.className = 'fa-solid fa-wave-square';
                startVisualizer('listening');
                break;

            case 'THINKING':
                micIcon.className = 'fa-solid fa-brain';
                stopVisualizer();
                break;

            case 'SPEAKING':
                micIcon.className = 'fa-solid fa-volume-high';
                startVisualizer('speaking');
                break;

            case 'ERROR':
                micIcon.className = 'fa-solid fa-triangle-exclamation';
                stopVisualizer();
                break;
        }
    }

    // --- Web Speech API Initialization ---
    function initializeSpeechRecognition() {
        const SpeechRecognition =
            window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            addMessage(
                "info",
                "Speech Recognition is not supported in this browser.",
                false
            );

            updateState('ERROR');
            return;
        }

        recognition = new SpeechRecognition();

        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = getRecognitionLanguage(
            state.selectedLanguage
        );

        recognition.onstart = () => {
            isRecognitionActive = true;
            updateState('LISTENING');
        };

        recognition.onend = () => {
            isRecognitionActive = false;

            if (state.current === 'LISTENING') {
                updateState('IDLE');
            }
        };

        recognition.onerror = (event) => {
            console.error(
                "Speech recognition error:",
                event.error
            );

            // This is normal when user doesn't speak.
            if (event.error === 'no-speech') {
                if (state.current === 'LISTENING') {
                    updateState('IDLE');
                }

                return;
            }

            addMessage(
                "info",
                `Speech Error: ${event.error}`,
                false
            );

            updateState('ERROR');

            setTimeout(() => {
                if (state.current === 'ERROR') {
                    updateState('IDLE');
                }
            }, 3000);
        };

        recognition.onresult = (event) => {
            const finalTranscript = Array.from(event.results)
                .filter(result => result.isFinal)
                .map(result => result[0].transcript)
                .join('');

            const command = finalTranscript.trim().toLowerCase();

            if (!command) {
                return;
            }

            // --- Speech interruption commands ---
            const stopCommands = [
                'jarvis stop',
                'stop',
                'ruk jao',
                'shut up',
                'chup raho'
            ];

            if (
                state.current === 'SPEAKING' &&
                stopCommands.some(stopCmd =>
                    command.includes(stopCmd)
                )
            ) {
                state.wasInterrupted = true;

                speechSynthesis.cancel();

                addMessage(
                    "info",
                    "Speech interrupted.",
                    false
                );

                return;
            }

            // Stop recognition after final command.
            if (isRecognitionActive) {
                try {
                    recognition.stop();
                } catch (error) {
                    console.warn(
                        "Recognition stop failed:",
                        error
                    );
                }
            }

            handleUserInput(command);
        };
    }

    // --- Speech Recognition Language ---
    function getRecognitionLanguage(selectedLang) {
        switch (selectedLang) {
            case 'Hindi':
                return 'hi-IN';

            case 'Hinglish':
                return 'en-IN';

            case 'English':
                return 'en-US';

            default:
                return 'en-US';
        }
    }

    // --- Core Functions ---

    function activateJarvis() {
        const welcomeMessages = {
            "English":
                "Hello Sir, how may I assist you?",

            "Hindi":
                "नमस्ते सर, मैं आपकी क्या सहायता कर सकता हूँ?",

            "Hinglish":
                "Hello Sir, main aapki kya help kar sakta hoon?"
        };

        const welcomeMessage =
            welcomeMessages[state.selectedLanguage];

        respondAndListen(welcomeMessage);
    }

    function respondAndListen(text) {
        addMessage(
            "Jarvis",
            text,
            false
        );

        speak(text, () => {
            if (
                !state.wasInterrupted &&
                recognition &&
                !isRecognitionActive
            ) {
                try {
                    recognition.start();
                } catch (error) {
                    console.warn(
                        "Recognition start failed:",
                        error
                    );

                    updateState('IDLE');
                }
            } else if (state.wasInterrupted) {
                state.wasInterrupted = false;
                updateState('IDLE');
            }
        });
    }

    async function handleUserInput(text) {
        if (
            !text ||
            state.current === 'THINKING' ||
            state.current === 'SPEAKING'
        ) {
            return;
        }

        addMessage(
            "You",
            text,
            false
        );

        updateState('THINKING');

        // First check local/system commands.
        const commandHandled =
            await handleSystemCommands(
                text.toLowerCase()
            );

        // Otherwise send to Gemini.
        if (!commandHandled) {
            await getGeminiResponse(text);
        }
    }

    // --- System Commands ---
    const systemCommands = {
        'activate': {
            keywords: [
                'hello jarvis',
                'wake up jarvis',
                'jarvis start'
            ],

            action: (command) => {
                if (
                    state.current === 'IDLE' ||
                    state.current === 'ERROR'
                ) {
                    activateJarvis();
                    return true;
                }

                return false;
            }
        },

        'owner': {
            keywords: [
                'your owner',
                'who created you',
                'who made you',
                'tumhara malik',
                'tumhe kisne banaya'
            ],

            action: () =>
                respondAndListen(
                    "I was created by Ritik Verma. He is my sole designer and owner."
                )
        },

        'time': {
            keywords: [
                'time',
                'samay',
                'waqt'
            ],

            action: () => {
                const time =
                    new Date().toLocaleTimeString(
                        'en-US',
                        {
                            hour: 'numeric',
                            minute: 'numeric',
                            hour12: true
                        }
                    );

                respondAndListen(
                    `Sir, the current time is ${time}.`
                );
            }
        },

        'date': {
            keywords: [
                'date',
                'tareekh',
                'dinank'
            ],

            action: () => {
                const date =
                    new Date().toLocaleDateString(
                        'en-GB',
                        {
                            day: 'numeric',
                            month: 'long',
                            year: 'numeric'
                        }
                    );

                respondAndListen(
                    `Sir, today's date is ${date}.`
                );
            }
        },

        'open': {
            keywords: [
                'open '
            ],

            action: (command) => {
                const siteRaw =
                    command
                        .replace('open ', '')
                        .trim();

                let site =
                    siteRaw.replace(/\s/g, '');

                if (!site.includes('.')) {
                    site += '.com';
                }

                if (
                    !site.startsWith('http://') &&
                    !site.startsWith('https://')
                ) {
                    site = `https://${site}`;
                }

                addMessage(
                    "Jarvis",
                    `Opening ${siteRaw}, Sir.`,
                    false
                );

                speak(
                    `Opening ${siteRaw}, Sir.`,
                    () => {
                        const newWindow =
                            window.open(
                                site,
                                '_blank'
                            );

                        if (newWindow) {
                            newWindow.focus();
                        }

                        if (
                            recognition &&
                            !isRecognitionActive
                        ) {
                            try {
                                recognition.start();
                            } catch (error) {
                                console.warn(
                                    "Recognition restart failed:",
                                    error
                                );
                            }
                        }
                    }
                );
            }
        },

        'weather': {
            keywords: [
                'weather',
                'mausam'
            ],

            action: getWeather
        },

        'reset': {
            keywords: [
                'reset conversation',
                'clear conversation',
                'start over'
            ],

            action: () => {
                state.conversationHistory = [];

                respondAndListen(
                    "Understood. I have cleared our conversation history. We can start fresh, Sir."
                );
            }
        },

        'goodbye': {
            keywords: [
                'goodbye',
                'shutdown',
                'exit',
                'bye jarvis'
            ],

            action: () => {
                addMessage(
                    "Jarvis",
                    "Goodbye, Sir. It was a pleasure assisting you.",
                    false
                );

                speak(
                    "Goodbye, Sir. It was a pleasure assisting you.",
                    () => {
                        updateState('IDLE');
                    }
                );
            }
        }
    };

    // --- Handle System Commands ---
    async function handleSystemCommands(command) {
        for (const key in systemCommands) {
            const {
                keywords,
                action
            } = systemCommands[key];

            const triggeredKeyword =
                keywords.find(keyword =>
                    command.includes(keyword)
                );

            if (triggeredKeyword) {
                if (key === 'activate') {
                    if (action(command)) {
                        return true;
                    }
                } else {
                    action(command);
                    return true;
                }
            }
        }

        return false;
    }

    // --- Weather ---
    async function getWeather() {
        if (!navigator.geolocation) {
            respondAndListen(
                "I'm sorry Sir, I can't retrieve your location to check the weather. Geolocation is not supported."
            );

            return;
        }

        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const {
                    latitude,
                    longitude
                } = position.coords;

                const weatherApiUrl =
                    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`;

                try {
                    const response =
                        await fetch(weatherApiUrl);

                    if (!response.ok) {
                        throw new Error(
                            `Weather API failed with status: ${response.status}`
                        );
                    }

                    const data =
                        await response.json();

                    if (
                        data.current &&
                        typeof data.current.temperature_2m !== 'undefined' &&
                        typeof data.current.weather_code !== 'undefined'
                    ) {
                        const temp =
                            Math.round(
                                data.current.temperature_2m
                            );

                        const weather =
                            getWeatherDescription(
                                data.current.weather_code
                            );

                        const weatherResponse =
                            `Sir, the current temperature is ${temp} degrees Celsius, with ${weather}.`;

                        respondAndListen(
                            weatherResponse
                        );
                    } else {
                        throw new Error(
                            "Invalid weather data received."
                        );
                    }
                } catch (error) {
                    console.error(
                        "Error fetching weather:",
                        error
                    );

                    respondAndListen(
                        "I'm having trouble fetching the weather data at the moment, Sir."
                    );
                }
            },

            (error) => {
                console.error(
                    "Geolocation error:",
                    error
                );

                let errorMessage =
                    "I need location access to provide the weather, Sir.";

                if (
                    error.code ===
                    error.PERMISSION_DENIED
                ) {
                    errorMessage =
                        "Sir, location access was denied. Please enable it in your browser settings.";
                } else if (
                    error.code ===
                    error.POSITION_UNAVAILABLE
                ) {
                    errorMessage =
                        "Sir, your location information is unavailable.";
                } else if (
                    error.code ===
                    error.TIMEOUT
                ) {
                    errorMessage =
                        "Sir, the location request timed out.";
                }

                respondAndListen(
                    errorMessage
                );
            },

            {
                enableHighAccuracy: false,
                timeout: 5000,
                maximumAge: 0
            }
        );
    }

    function getWeatherDescription(code) {
        const descriptions = {
            0: "clear skies",
            1: "mainly clear skies",
            2: "partly cloudy skies",
            3: "overcast skies",

            45: "fog",
            48: "depositing rime fog",

            51: "light drizzle",
            53: "moderate drizzle",
            55: "dense drizzle",

            56: "light freezing drizzle",
            57: "dense freezing drizzle",

            61: "a slight rain",
            63: "moderate rain",
            65: "heavy rain",

            66: "light freezing rain",
            67: "heavy freezing rain",

            71: "slight snow fall",
            73: "moderate snow fall",
            75: "heavy snow fall",

            77: "snow grains",

            80: "slight rain showers",
            81: "moderate rain showers",
            82: "violent rain showers",

            85: "slight snow showers",
            86: "heavy snow showers",

            95: "a slight thunderstorm",
            96: "a thunderstorm with slight hail",
            99: "a thunderstorm with heavy hail"
        };

        return (
            descriptions[code] ||
            "an unknown weather condition"
        );
    }

    // --- Gemini API ---
    async function getGeminiResponse(prompt) {
        if (isGeminiRequestActive) {
            console.warn(
                "A Gemini request is already active."
            );

            return;
        }

        isGeminiRequestActive = true;

        // Check API key.
        if (
            !GOOGLE_API_KEY ||
            GOOGLE_API_KEY === 'API_KEY' ||
            GOOGLE_API_KEY === 'YOUR_GOOGLE_AI_STUDIO_API_KEY_HERE'
        ) {
            isGeminiRequestActive = false;

            const message =
                "My connection to the Google AI core is not configured. Please add your Google AI Studio API key, Sir.";

            addMessage(
                "info",
                message,
                false
            );

            updateState('ERROR');

            setTimeout(() => {
                if (state.current === 'ERROR') {
                    updateState('IDLE');
                }
            }, 3000);

            return;
        }

        // Build conversation contents.
        const messages = state.conversationHistory
            .map(item => ({
                role:
                    item.role === 'user'
                        ? 'user'
                        : 'model',

                parts: [
                    {
                        text: item.content
                    }
                ]
            }));

        // Add current user prompt.
        messages.push({
            role: 'user',
            parts: [
                {
                    text: prompt
                }
            ]
        });

        // Add current user message to local history.
        state.conversationHistory.push({
            role: 'user',
            content: prompt
        });

        // Keep history manageable.
        if (
            state.conversationHistory.length > 10
        ) {
            state.conversationHistory =
                state.conversationHistory.slice(-10);
        }

        try {
            const response = await fetch(
                GOOGLE_API_URL,
                {
                    method: 'POST',

                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': GOOGLE_API_KEY
                    },

                    body: JSON.stringify({
                        systemInstruction: {
                            parts: [
                                {
                                    text: systemPrompts[
                                        state.selectedLanguage
                                    ]
                                }
                            ]
                        },

                        contents: messages,

                        generationConfig: {
                            temperature: 0.7,
                            maxOutputTokens: 200
                        }
                    })
                }
            );

            // Read response safely.
            let data;

            try {
                data = await response.json();
            } catch (parseError) {
                throw new Error(
                    `Gemini returned a non-JSON response. HTTP status: ${response.status}`
                );
            }

            if (!response.ok) {
                console.error(
                    "Google AI API response error data:",
                    data
                );

                const apiMessage =
                    data?.error?.message ||
                    response.statusText ||
                    "Unknown Gemini API error";

                throw new Error(
                    `Google AI API error: ${response.status} - ${apiMessage}`
                );
            }

            const reply =
                data?.candidates?.[0]
                    ?.content?.parts
                    ?.map(part => part.text || '')
                    .join('')
                    .trim();

            if (!reply) {
                console.error(
                    "Unexpected Gemini response:",
                    data
                );

                throw new Error(
                    "Empty response or no candidate returned by Google Gemini."
                );
            }

            // Save Gemini response.
            state.conversationHistory.push({
                role: 'assistant',
                content: reply
            });

            // Keep only latest 10 messages.
            if (
                state.conversationHistory.length > 10
            ) {
                state.conversationHistory =
                    state.conversationHistory.slice(-10);
            }

            respondAndListen(reply);

        } catch (error) {
            console.error(
                "Error fetching from Google AI API:",
                error
            );

            let errorMessage =
                "My apologies Sir, I'm having trouble connecting to my core systems. Please try again.";

            // More useful error messages.
            if (
                error.message.includes('400')
            ) {
                errorMessage =
                    "Sir, the Gemini request was invalid. Please check the API configuration.";
            } else if (
                error.message.includes('401') ||
                error.message.includes('403')
            ) {
                errorMessage =
                    "Sir, the Gemini API key was rejected. Please check whether the key is valid and has access to the Gemini API.";
            } else if (
                error.message.includes('404')
            ) {
                errorMessage =
                    "Sir, the requested Gemini model was not found. Please verify the model name.";
            } else if (
                error.message.includes('429')
            ) {
                errorMessage =
                    "Sir, the Gemini API rate limit was reached. Please try again shortly.";
            }

            addMessage(
                "info",
                errorMessage,
                false
            );

            speechSynthesis.cancel();

            updateState('ERROR');

            setTimeout(() => {
                if (state.current === 'ERROR') {
                    updateState('IDLE');
                }
            }, 3000);

        } finally {
            isGeminiRequestActive = false;
        }
    }

    // --- Speech Synthesis ---
    function speak(text, onEndCallback) {
        if (
            !('speechSynthesis' in window)
        ) {
            console.warn(
                "Speech Synthesis not supported in this browser."
            );

            addMessage(
                "info",
                "Speech output is not supported by your browser.",
                false
            );

            if (onEndCallback) {
                onEndCallback();
            }

            return;
        }

        updateState('SPEAKING');

        speechSynthesis.cancel();

        state.wasInterrupted = false;

        const utterance =
            new SpeechSynthesisUtterance(text);

        // Voice settings.
        const voices =
            speechSynthesis.getVoices();

        let targetLang = 'en-US';
        let rate = 0.95;
        let pitch = 1;

        if (
            state.selectedLanguage === 'Hindi'
        ) {
            targetLang = 'hi-IN';
            rate = 0.9;

        } else if (
            state.selectedLanguage === 'Hinglish'
        ) {
            targetLang = 'en-IN';
            rate = 0.95;

        } else {
            targetLang = 'en-GB';
        }

        // Prefer Google voice.
        let selectedVoice =
            voices.find(
                voice =>
                    voice.lang === targetLang &&
                    voice.name.includes('Google')
            );

        // Fallback to exact language.
        if (!selectedVoice) {
            selectedVoice =
                voices.find(
                    voice =>
                        voice.lang === targetLang
                );
        }

        // Fallback to English.
        if (!selectedVoice) {
            selectedVoice =
                voices.find(
                    voice =>
                        voice.lang.startsWith('en')
                );
        }

        if (selectedVoice) {
            utterance.voice =
                selectedVoice;

            utterance.lang =
                selectedVoice.lang;
        } else {
            utterance.lang = 'en-US';
        }

        utterance.pitch = pitch;
        utterance.rate = rate;

        utterance.onend = () => {
            if (!state.wasInterrupted) {
                updateState('IDLE');
            }

            if (onEndCallback) {
                onEndCallback();
            }
        };

        utterance.onerror = (event) => {
            console.error(
                "Speech synthesis error:",
                event
            );

            addMessage(
                "info",
                "Sorry, I had trouble speaking that, Sir.",
                false
            );

            updateState('ERROR');

            setTimeout(() => {
                if (state.current === 'ERROR') {
                    updateState('IDLE');
                }
            }, 3000);

            if (onEndCallback) {
                onEndCallback();
            }
        };

        speechSynthesis.speak(
            utterance
        );
    }

    // --- Chat Messages ---
    function addMessage(
        sender,
        text,
        useSound
    ) {
        // useSound is kept for compatibility.
        // No notification audio is used.

        const messageWrapper =
            document.createElement('div');

        messageWrapper.classList.add(
            'chat-bubble',
            sender.toLowerCase()
        );

        const timestamp =
            new Date().toLocaleTimeString(
                [],
                {
                    hour: '2-digit',
                    minute: '2-digit'
                }
            );

        const timestampSpan =
            `<span class="timestamp">${timestamp}</span>`;

        const messageContent =
            document.createElement('div');

        messageContent.innerHTML =
            `${timestampSpan} ${text}`;

        messageWrapper.appendChild(
            messageContent
        );

        chatLog.prepend(
            messageWrapper
        );

        chatLog.parentElement.scrollTop = 0;
    }

    // --- Audio Visualizer ---
    async function initAudioVisualizer() {
        if (audioContext) {
            return;
        }

        try {
            const stream =
                await navigator.mediaDevices
                    .getUserMedia({
                        audio: true
                    });

            audioContext =
                new (
                    window.AudioContext ||
                    window.webkitAudioContext
                )();

            analyser =
                audioContext.createAnalyser();

            source =
                audioContext.createMediaStreamSource(
                    stream
                );

            source.connect(analyser);

            analyser.fftSize = 256;

            dataArray =
                new Uint8Array(
                    analyser.frequencyBinCount
                );

            visualizerCanvas.width =
                visualizerCanvas.offsetWidth;

            visualizerCanvas.height =
                visualizerCanvas.offsetHeight;

        } catch (err) {
            console.error(
                "Microphone access denied for visualizer.",
                err
            );

            addMessage(
                "info",
                "Microphone access is needed for visual effects.",
                false
            );

            updateState('ERROR');

            setTimeout(() => {
                if (state.current === 'ERROR') {
                    updateState('IDLE');
                }
            }, 3000);
        }
    }

    function startVisualizer(mode) {
        if (
            !analyser ||
            !dataArray
        ) {
            initAudioVisualizer()
                .then(() => {
                    if (
                        analyser &&
                        dataArray
                    ) {
                        _startDrawing(mode);
                    }
                });

            return;
        }

        _startDrawing(mode);
    }

    function _startDrawing(mode) {
        if (animationFrameId) {
            cancelAnimationFrame(
                animationFrameId
            );
        }

        const draw = () => {
            animationFrameId =
                requestAnimationFrame(draw);

            const WIDTH =
                visualizerCanvas.width;

            const HEIGHT =
                visualizerCanvas.height;

            canvasCtx.clearRect(
                0,
                0,
                WIDTH,
                HEIGHT
            );

            if (
                mode === 'listening' &&
                analyser &&
                dataArray
            ) {
                analyser.getByteFrequencyData(
                    dataArray
                );

                const barWidth =
                    (WIDTH /
                        dataArray.length) *
                    2.5;

                let x = 0;

                for (
                    let i = 0;
                    i < dataArray.length;
                    i++
                ) {
                    const barHeight =
                        dataArray[i] / 2.5;

                    canvasCtx.fillStyle =
                        `rgba(0, 255, 255, ${barHeight / 150})`;

                    canvasCtx.fillRect(
                        x,
                        HEIGHT - barHeight,
                        barWidth,
                        barHeight
                    );

                    x +=
                        barWidth + 1;
                }

            } else if (
                mode === 'speaking'
            ) {
                const time =
                    Date.now() * 0.008;

                canvasCtx.lineWidth = 2;

                canvasCtx.strokeStyle =
                    'rgb(0, 255, 255)';

                canvasCtx.beginPath();

                const sliceWidth =
                    WIDTH / 128;

                let x = 0;

                for (
                    let i = 0;
                    i < 128;
                    i++
                ) {
                    const v =
                        0.5 +
                        Math.sin(
                            i * 0.2 + time
                        ) *
                        Math.cos(
                            i * 0.1 + time
                        ) *
                        0.4;

                    const y =
                        v * HEIGHT;

                    if (i === 0) {
                        canvasCtx.moveTo(
                            x,
                            y
                        );
                    } else {
                        canvasCtx.lineTo(
                            x,
                            y
                        );
                    }

                    x += sliceWidth;
                }

                canvasCtx.stroke();
            }
        };

        draw();
    }

    function stopVisualizer() {
        if (animationFrameId) {
            cancelAnimationFrame(
                animationFrameId
            );

            animationFrameId = null;

            setTimeout(() => {
                canvasCtx.clearRect(
                    0,
                    0,
                    visualizerCanvas.width,
                    visualizerCanvas.height
                );
            }, 100);
        }
    }

    // --- AI Core Click Event ---
    aiCore.addEventListener(
        'click',
        () => {
            if (!recognition) {
                addMessage(
                    "info",
                    "Speech recognition not initialized.",
                    false
                );

                return;
            }

            // Initialize visualizer.
            initAudioVisualizer();

            switch (state.current) {

                case 'IDLE':
                case 'ERROR':
                    if (isRecognitionActive) {
                        return;
                    }

                    try {
                        recognition.start();

                    } catch (error) {
                        console.warn(
                            "Recognition start failed:",
                            error
                        );

                        if (!isRecognitionActive) {
                            addMessage(
                                "info",
                                "Could not start listening. Please check microphone.",
                                false
                            );

                            updateState(
                                'ERROR'
                            );

                            setTimeout(() => {
                                if (
                                    state.current ===
                                    'ERROR'
                                ) {
                                    updateState(
                                        'IDLE'
                                    );
                                }
                            }, 3000);
                        }
                    }

                    break;

                case 'LISTENING':
                    try {
                        recognition.stop();
                    } catch (error) {
                        console.warn(
                            "Recognition stop failed:",
                            error
                        );
                    }

                    addMessage(
                        "info",
                        "Listening stopped.",
                        false
                    );

                    break;

                case 'SPEAKING':
                    state.wasInterrupted =
                        true;

                    speechSynthesis.cancel();

                    addMessage(
                        "info",
                        "Speech interrupted.",
                        false
                    );

                    break;

                case 'THINKING':
                    addMessage(
                        "info",
                        "I'm currently processing, Sir. Please wait.",
                        false
                    );

                    break;
            }
        }
    );

    // --- Voices Loaded ---
    window.speechSynthesis.onvoiceschanged = () => {
        console.log(
            "Speech synthesis voices loaded."
        );

        if (
            state.current === 'IDLE' &&
            !recognition
        ) {
            initializeSpeechRecognition();
        }
    };

    // --- Language Buttons ---
    langButtons.forEach(button => {
        button.addEventListener(
            'click',
            () => {
                langButtons.forEach(btn =>
                    btn.classList.remove(
                        'active'
                    )
                );

                button.classList.add(
                    'active'
                );

                state.selectedLanguage =
                    button.dataset.lang;

                if (recognition) {
                    recognition.lang =
                        getRecognitionLanguage(
                            state.selectedLanguage
                        );

                    if (
                        isRecognitionActive
                    ) {
                        try {
                            recognition.stop();
                        } catch (error) {
                            console.warn(
                                "Recognition stop failed during language change:",
                                error
                            );
                        }
                    }

                } else {
                    initializeSpeechRecognition();
                }

                addMessage(
                    "info",
                    `Language profile set to ${state.selectedLanguage}.`,
                    false
                );
            }
        );
    });

    // --- Initial Setup ---
    initializeSpeechRecognition();

    updateState('IDLE');

    initAudioVisualizer();

    // Helpful console information.
    console.log(
        `J.A.R.V.I.S. initialized with Gemini model: ${GEMINI_MODEL}`
    );
});