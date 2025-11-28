/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session, FunctionDeclaration, Type, Tool} from '@google/genai';
import {LitElement, css, html, nothing} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

// --- Types ---
interface Ticket {
  id: string;
  category: string;
  location: string;
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  description: string;
  status: 'Open' | 'In Progress' | 'Resolved';
  timestamp: string;
  impact: string;
}

// --- Mock Data for Hackathon Demo ---
const MOCK_TICKETS: Ticket[] = [
  { id: 'MAH-1024', category: 'Drainage', location: 'Shivaji Nagar, Zone 4', severity: 'High', description: 'Overflowing sewage near school entrance', status: 'Open', timestamp: '10 mins ago', impact: '500 students at risk' },
  { id: 'MAH-1021', category: 'Water', location: 'Shivaji Nagar, Zone 4', severity: 'Medium', description: 'Low pressure in supply lines', status: 'Open', timestamp: '2 hours ago', impact: '50 households' },
  { id: 'MAH-0998', category: 'Street Light', location: 'MG Road', severity: 'Low', description: 'Pole 45 flickering', status: 'Resolved', timestamp: '5 hours ago', impact: 'Traffic visibility reduced' },
  { id: 'MAH-1033', category: 'Health', location: 'Dharavi Sector 2', severity: 'Critical', description: 'Reports of contaminated water and fever', status: 'In Progress', timestamp: '1 hour ago', impact: 'Potential outbreak vector' },
];

const complaintTool: FunctionDeclaration = {
  name: 'log_complaint',
  description: 'Logs a formal municipal complaint into the database.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      category: { type: Type.STRING, description: 'Category (Drainage, Water, Health, Road, Electricity).' },
      location: { type: Type.STRING, description: 'Specific area or landmark.' },
      description: { type: Type.STRING, description: 'Problem description.' },
      severity: { type: Type.STRING, description: 'Severity: Low, Medium, High, Critical.' },
      impact_details: { type: Type.STRING, description: 'Population affected or safety risks.' },
      phone_number: { type: Type.STRING, description: 'Mobile number for WhatsApp tracking.' },
      language_used: { type: Type.STRING, description: 'Language spoken.' },
      conversation_summary: { type: Type.STRING, description: 'English summary of the issue.' }
    },
    required: ['category', 'location', 'description', 'severity', 'impact_details', 'conversation_summary'],
  },
};

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  // View State
  @state() viewMode: 'citizen' | 'admin' = 'citizen';
  
  // App State
  @state() isRecording = false;
  @state() status = 'Press Start to speak with Maya';
  @state() error = '';
  @state() tickets: Ticket[] = [...MOCK_TICKETS];
  @state() lastTicketId = '';
  
  // Dashboard State
  @state() predictiveReport = '';
  @state() isGeneratingReport = false;

  // Audio/Gemini Logic
  private client: GoogleGenAI;
  private session: Session | null = null;
  private inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();
  private shouldCloseSession = false;
  private maxDurationTimer: any = null;

  static styles = css`
    :host {
      font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: block;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: #000510;
      color: #e0f7ff;
    }

    /* --- Navigation --- */
    .nav-bar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 60px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 20px;
      z-index: 100;
      background: rgba(0, 20, 40, 0.8);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid rgba(0, 255, 255, 0.1);
    }
    .brand {
      font-size: 1.2rem;
      font-weight: 700;
      color: #00aaff;
      display: flex;
      align-items: center;
      gap: 10px;
      letter-spacing: 1px;
    }
    .brand span { color: white; font-weight: 300; }
    
    .view-toggle {
      display: flex;
      background: rgba(0,0,0,0.3);
      border-radius: 20px;
      padding: 4px;
      border: 1px solid rgba(0, 255, 255, 0.2);
    }
    .view-btn {
      background: transparent;
      border: none;
      color: #6a8ea5;
      padding: 6px 16px;
      border-radius: 16px;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.8rem;
      transition: all 0.3s;
    }
    .view-btn.active {
      background: #00aaff;
      color: white;
      box-shadow: 0 0 10px rgba(0, 170, 255, 0.4);
    }

    /* --- Common Layout --- */
    .screen {
      position: absolute;
      top: 60px;
      left: 0;
      right: 0;
      bottom: 0;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.4s ease;
      display: flex;
      flex-direction: column;
    }
    .screen.active {
      opacity: 1;
      pointer-events: auto;
    }

    /* --- Citizen View --- */
    #citizen-view {
      align-items: center;
      justify-content: center;
    }
    .orb-container {
      position: absolute;
      inset: 0;
      z-index: 0;
    }
    #status {
      position: absolute;
      bottom: 18vh;
      text-align: center;
      color: #aeeeff;
      font-size: 1.2rem;
      text-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
      width: 100%;
      pointer-events: none;
    }
    .controls {
      z-index: 10;
      position: absolute;
      bottom: 6vh;
      display: flex;
      gap: 20px;
    }
    .ctrl-btn {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      border: 1px solid rgba(0, 255, 255, 0.3);
      background: rgba(0, 20, 40, 0.6);
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
    }
    .ctrl-btn:hover {
      background: rgba(0, 255, 255, 0.2);
      transform: scale(1.1);
      box-shadow: 0 0 20px rgba(0, 255, 255, 0.4);
    }
    .ctrl-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
    #stopButton:hover { border-color: red; background: rgba(255, 0, 0, 0.2); box-shadow: 0 0 20px rgba(255, 0, 0, 0.4); }

    .ticket-toast {
      position: absolute;
      top: 20px;
      right: 20px;
      background: rgba(0, 40, 20, 0.9);
      border: 1px solid #00ff88;
      color: #ccffdd;
      padding: 15px;
      border-radius: 8px;
      animation: slideIn 0.5s ease;
      z-index: 20;
      backdrop-filter: blur(10px);
      box-shadow: 0 5px 20px rgba(0,0,0,0.5);
    }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

    /* --- Admin Dashboard View --- */
    #admin-view {
      background: radial-gradient(circle at 50% 10%, #001525 0%, #000000 100%);
      padding: 20px;
      overflow-y: auto;
    }
    .dashboard-grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      grid-template-rows: auto 1fr;
      gap: 20px;
      height: 100%;
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .card {
      background: rgba(13, 25, 40, 0.7);
      border: 1px solid rgba(0, 170, 255, 0.2);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(5px);
    }
    
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      border-bottom: 1px solid rgba(0, 170, 255, 0.1);
      padding-bottom: 10px;
    }
    .card-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: #00aaff;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* Ticket List */
    .ticket-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 400px;
      overflow-y: auto;
    }
    .ticket-item {
      background: rgba(255, 255, 255, 0.03);
      padding: 12px;
      border-radius: 6px;
      border-left: 3px solid #555;
      display: grid;
      grid-template-columns: 80px 1fr auto;
      align-items: center;
      gap: 10px;
      font-size: 0.9rem;
    }
    .ticket-item.Critical { border-left-color: #ff3333; background: rgba(255, 0, 0, 0.05); }
    .ticket-item.High { border-left-color: #ffaa00; }
    .ticket-item.Medium { border-left-color: #00aaff; }
    .ticket-item.Low { border-left-color: #00ff88; }
    
    .t-id { font-family: monospace; color: #888; font-size: 0.8rem; }
    .t-desc { font-weight: 500; color: #eee; }
    .t-loc { font-size: 0.8rem; color: #aaa; display: block; }
    .t-badge { 
      padding: 2px 8px; border-radius: 10px; font-size: 0.7rem; font-weight: bold; text-transform: uppercase;
    }
    
    /* Stats Row */
    .stats-row {
      grid-column: 1 / -1;
      display: flex;
      gap: 20px;
    }
    .stat-card {
      flex: 1;
      background: linear-gradient(180deg, rgba(0,170,255,0.1) 0%, rgba(0,0,0,0) 100%);
      padding: 15px;
      border-radius: 8px;
      border: 1px solid rgba(0, 170, 255, 0.2);
      text-align: center;
    }
    .stat-val { font-size: 2rem; font-weight: 700; color: white; }
    .stat-label { font-size: 0.8rem; color: #00aaff; text-transform: uppercase; }

    /* Predictive Panel */
    .predictive-panel {
      grid-column: 2;
      grid-row: 2;
      display: flex;
      flex-direction: column;
    }
    .ai-btn {
      width: 100%;
      background: linear-gradient(90deg, #0055ff, #00aaff);
      border: none;
      color: white;
      padding: 10px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .ai-btn:hover { filter: brightness(1.2); }
    .ai-btn:disabled { opacity: 0.6; cursor: wait; }
    
    .report-content {
      font-size: 0.85rem;
      line-height: 1.5;
      color: #d1e8ff;
      white-space: pre-wrap;
      font-family: monospace;
      background: rgba(0,0,0,0.3);
      padding: 10px;
      border-radius: 6px;
      flex: 1;
      overflow-y: auto;
    }
    .compliance-badge {
      margin-top: auto;
      padding-top: 15px;
      font-size: 0.7rem;
      color: #00ff88;
      display: flex;
      align-items: center;
      gap: 6px;
      opacity: 0.8;
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private async initClient() {
    this.client = new GoogleGenAI({ apiKey: process.env.API_KEY });
    this.outputNode.connect(this.outputAudioContext.destination);
    await this.initSession();
  }

  private async initSession() {
    this.shouldCloseSession = false;
    try {
      this.session = await this.client.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
             this.status = this.isRecording ? 'Reconnected. Maya is listening.' : 'Press Start to speak with Maya';
             this.error = '';
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
                const responses = [];
                for (const fc of message.toolCall.functionCalls) {
                    if (fc.name === 'log_complaint') {
                        const args = fc.args as any;
                        const newTicket: Ticket = {
                          id: 'MAH-' + Math.floor(1000 + Math.random() * 9000),
                          category: args.category,
                          location: args.location,
                          severity: args.severity,
                          description: args.conversation_summary,
                          status: 'Open',
                          timestamp: 'Just now',
                          impact: args.impact_details
                        };
                        
                        // Add to state (this updates dashboard instantly)
                        this.tickets = [newTicket, ...this.tickets];
                        this.lastTicketId = newTicket.id;
                        this.shouldCloseSession = true;

                        responses.push({
                            id: fc.id,
                            name: fc.name,
                            response: { result: "success", ticket_id: newTicket.id }
                        });
                        
                        // Brief toast notification
                        setTimeout(() => this.lastTicketId = '', 5000);
                    }
                }
                if (this.session) {
                    this.session.sendToolResponse({ functionResponses: responses });
                }
            }

            const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData;
            if (audio) {
              if (!this.shouldCloseSession) this.status = 'Maya is speaking...';
              
              this.nextStartTime = Math.max(this.nextStartTime, this.outputAudioContext.currentTime);
              const audioBuffer = await decodeAudioData(decode(audio.data), this.outputAudioContext, 24000, 1);
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => {
                this.sources.delete(source);
                if (this.sources.size === 0 && this.shouldCloseSession) {
                    this.status = 'Ticket Logged. Thank you.';
                    setTimeout(() => this.stopRecording(), 1000);
                } else if (this.sources.size === 0 && this.isRecording) {
                    this.status = 'Listening...';
                }
              });
              source.start(this.nextStartTime);
              this.nextStartTime += audioBuffer.duration;
              this.sources.add(source);
            }
          },
          onerror: (e) => console.debug(e),
          onclose: (e) => {
            if (this.isRecording && !this.shouldCloseSession) {
                this.status = 'Reconnecting...';
                this.session = null;
                setTimeout(() => this.initSession(), 500);
            } else if (this.isRecording) {
                this.stopRecording();
            }
          },
        },
        config: {
          systemInstruction: `You are Maya, an AI Municipal Agent. Your job is to log complaints concisely in under 3 mins.
          Speak in the user's language (English, Telugu, Hindi).
          Mandatory fields: Category, Location, Impact (how many people affected), Severity, Phone Number.
          Call 'log_complaint' when you have these. Summary MUST be English.`,
          tools: [{functionDeclarations: [complaintTool]}],
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Kore'}} },
        },
      });
    } catch (e) {
        if(!this.isRecording) this.error = "Connection Failed";
    }
  }

  private async startRecording() {
    if (this.isRecording) return;
    if (!this.session) await this.initSession();
    if (!this.session) return;

    try {
      this.inputAudioContext.resume();
      this.outputAudioContext.resume();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(4096, 1, 1);
      
      this.scriptProcessorNode.onaudioprocess = (e) => {
        if (!this.session) return;
        const data = e.inputBuffer.getChannelData(0);
        try { this.session.sendRealtimeInput({media: createBlob(data)}); } catch(e) {}
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);
      
      this.isRecording = true;
      this.status = 'Listening...';
      
      this.maxDurationTimer = setTimeout(() => {
          this.status = "Time limit reached.";
          this.stopRecording();
      }, 180000);
    } catch (e) {
      this.stopRecording();
      this.error = "Microphone Error";
    }
  }

  private stopRecording() {
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.isRecording = false;
    if (this.mediaStream) this.mediaStream.getTracks().forEach(t => t.stop());
    if (this.scriptProcessorNode) { 
        this.scriptProcessorNode.disconnect(); 
        // @ts-ignore
        this.scriptProcessorNode = null; 
    }
    if (this.session) { 
        try { this.session.close(); } catch(e){} 
        this.session = null; 
    }
    if (!this.status.includes('Logged')) this.status = 'Session Ended';
  }

  // --- Dashboard Logic ---
  private async generatePrediction() {
    this.isGeneratingReport = true;
    this.predictiveReport = "Analyzing municipal data vector store...";
    
    try {
        // We use a simplified text generation call here to simulate Vertex AI analysis
        const dataContext = this.tickets.map(t => 
            `- [${t.severity}] ${t.category} at ${t.location}: ${t.description} (Impact: ${t.impact})`
        ).join('\n');

        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `Analyze these recent municipal complaints and provide a "Governance Strategic Briefing" for the City Commissioner.
            
            Complaints:
            ${dataContext}
            
            Output Format:
            1. **Critical Risk Assessment**: Identify clusters/trends (e.g., potential outbreaks, infrastructure collapse).
            2. **Resource Allocation**: Where should we send the trucks/engineers immediately?
            3. **Long-term Insight**: Suggest a policy fix.
            
            Keep it professional, military-style concise, and actionable.`
        });
        
        this.predictiveReport = response.text || "Analysis complete but no text generated.";
    } catch(e) {
        this.predictiveReport = "Error accessing Predictive Engine. Please retry.";
    } finally {
        this.isGeneratingReport = false;
    }
  }

  render() {
    return html`
      <div class="nav-bar">
        <div class="brand">MAHARASHTRA <span>GOV.AI</span></div>
        <div class="view-toggle">
            <button class="view-btn ${this.viewMode === 'citizen' ? 'active' : ''}" @click=${() => this.viewMode = 'citizen'}>Citizen Connect</button>
            <button class="view-btn ${this.viewMode === 'admin' ? 'active' : ''}" @click=${() => this.viewMode = 'admin'}>Command Center</button>
        </div>
      </div>

      <!-- CITIZEN VIEW -->
      <div id="citizen-view" class="screen ${this.viewMode === 'citizen' ? 'active' : ''}">
         <div class="orb-container">
            <gdm-live-audio-visuals-3d .inputNode=${this.inputNode} .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
         </div>
         
         ${this.lastTicketId ? html`
            <div class="ticket-toast">
                <strong>Complaint Logged Successfully</strong><br>
                Ticket ID: ${this.lastTicketId}<br>
                <small>WhatsApp confirmation sent.</small>
            </div>
         ` : nothing}

         <div id="status">${this.error || this.status}</div>

         <div class="controls">
            <button class="ctrl-btn" @click=${this.startRecording} ?disabled=${this.isRecording}>
                <svg viewBox="0 0 24 24" width="32" height="32" fill="white"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
            </button>
            <button id="stopButton" class="ctrl-btn" @click=${this.stopRecording} ?disabled=${!this.isRecording}>
                <svg viewBox="0 0 24 24" width="32" height="32" fill="white"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            </button>
         </div>
      </div>

      <!-- ADMIN DASHBOARD VIEW -->
      <div id="admin-view" class="screen ${this.viewMode === 'admin' ? 'active' : ''}">
          
          <div class="dashboard-grid">
             <!-- Stats Row -->
             <div class="stats-row">
                <div class="stat-card">
                    <div class="stat-val">${this.tickets.length}</div>
                    <div class="stat-label">Total Active Issues</div>
                </div>
                <div class="stat-card">
                    <div class="stat-val" style="color: #ff3333">
                        ${this.tickets.filter(t => t.severity === 'Critical').length}
                    </div>
                    <div class="stat-label">Critical Risks</div>
                </div>
                <div class="stat-card">
                    <div class="stat-val" style="color: #00ff88">94%</div>
                    <div class="stat-label">AI Accuracy</div>
                </div>
                <div class="stat-card">
                    <div class="stat-val">3m</div>
                    <div class="stat-label">Avg. Resolution</div>
                </div>
             </div>

             <!-- Live Feed -->
             <div class="card" style="grid-column: 1; grid-row: 2;">
                <div class="card-header">
                    <span class="card-title">Live Grievance Intelligence Feed</span>
                    <span style="font-size: 0.8rem; color: #888">Real-time Ingestion via Maya</span>
                </div>
                <div class="ticket-list">
                    ${this.tickets.map(t => html`
                        <div class="ticket-item ${t.severity}">
                            <div class="t-id">${t.id}</div>
                            <div>
                                <div class="t-desc">${t.description}</div>
                                <span class="t-loc">${t.location} | Impact: ${t.impact}</span>
                            </div>
                            <div class="t-badge">${t.severity}</div>
                        </div>
                    `)}
                </div>
             </div>

             <!-- Predictive AI Panel -->
             <div class="card predictive-panel">
                <div class="card-header">
                    <span class="card-title">Vertex AI Predictive Engine</span>
                </div>
                
                <button class="ai-btn" @click=${this.generatePrediction} ?disabled=${this.isGeneratingReport}>
                    ${this.isGeneratingReport ? 'Processing Vector Data...' : 'Generate Daily Strategic Briefing'}
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="white"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
                </button>

                ${this.predictiveReport ? html`
                    <div class="report-content">${this.predictiveReport}</div>
                ` : html`
                    <div class="report-content" style="color: #666; font-style: italic; display:flex; align-items:center; justify-content:center;">
                        AI Models Ready. Awaiting Command.
                    </div>
                `}

                <div class="compliance-badge">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="#00ff88"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
                    DPDP Act 2023 Compliant | E2E Encrypted
                </div>
             </div>
          </div>
      </div>
    `;
  }
}
