# EAS Technical Architecture

> Complete end-to-end architecture reference for the Educational Agentic System.

---

## High-Level System Topology

```mermaid
graph TD
    Learner["Learner (Browser)"]

    subgraph Frontend ["Next.js 16 Web Application"]
        Landing["Landing Showcase Page (/)"]
        ChatCanvas["Chat Canvas and Visualizers (/chat)"]
        ReadingWS["Reading Workspace (/learning/reading)"]
        MasteryWS["Mastery Workspace (/learning/mastery)"]
        SettingsUI["Settings and Provider Manager (/settings)"]
        DocViewer["Split-Screen Document Viewer"]
        ChatRuntime["ChatRuntime and Knowledge Adapter"]
    end

    subgraph Backend ["FastAPI Agentic Core"]
        Gateway["FastAPI Gateway (Port 8001)"]
        TurnEngine["Agentic Turn Pipeline"]
        VisualizerSynth["Visualizer Synthesis Engine"]
        RAGIndexer["RAG and Citation Indexer"]
        MemoryStack["L1-L3 Memory System"]
        LearningEngine["Adaptive Learning Engine"]
        ToolRegistry["Tool Registry and Dispatch"]
        ProviderRegistry["LLM Provider Registry"]
        MultiUser["Multi-User Identity and Grants"]
    end

    subgraph Sandbox ["Execution Sandbox"]
        Runner["Sandbox Runner Sidecar (Port 8900)"]
    end

    subgraph Storage ["Storage Layer"]
        Redis[("Redis 7.4 Coordinator")]
        SQLite[("SQLite (Sessions, Vectors, Metadata)")]
        PocketBase[("PocketBase Auth (Port 8090)")]
        FileSystem[("Document Library and Workspace")]
    end

    Learner -->|"HTTPS / WSS"| Frontend
    Landing -->|"CTA: Open learning space"| ChatCanvas
    ChatCanvas <-->|"REST + WebSocket"| Gateway
    ReadingWS <-->|"REST + WebSocket"| Gateway
    MasteryWS <-->|"REST + WebSocket"| Gateway
    SettingsUI -->|"REST"| Gateway
    DocViewer <--> Gateway
    ChatRuntime <--> Gateway

    Gateway --> TurnEngine
    TurnEngine --> VisualizerSynth
    TurnEngine --> RAGIndexer
    TurnEngine --> MemoryStack
    TurnEngine --> LearningEngine
    TurnEngine --> ToolRegistry
    TurnEngine --> ProviderRegistry
    TurnEngine --> MultiUser

    ToolRegistry -.->|"Isolated exec"| Runner

    Backend <--> Redis
    Backend <--> SQLite
    Backend <--> PocketBase
    Backend <--> FileSystem
```

---

## Frontend Architecture

```mermaid
graph TD
    subgraph AppRouter ["Next.js 16 App Router"]
        direction TB
        LandingRoute["(landing) group: / route"]
        AuthRoute["(auth) group: /login, /register"]
        WorkspaceRoute["(workspace) group: /chat, /learning/*"]
        SettingsRoute["(settings) group: /settings/*"]
        UtilityRoute["(utility) group: /avatar-preview, /whiteboard"]
        AdminRoute["(admin) group: /admin/*"]
        APIRoute["api/ route handlers"]
    end

    subgraph UILayer ["Component and Feature Layer"]
        LandingPage["Landing Screen, Header Actions, Visual Steps"]
        AppShell["AppShell: Sidebar, TopBar, PanelManager"]
        ChatComposer["Chat Composer, Message Bubbles, Turn Trace"]
        VisCanvas["Visualizer Canvas (HTML, SVG, Mermaid, Chart.js, GeoGebra, Cytoscape)"]
        ReaderPane["Split-Screen PDF/EPUB/DOCX Reader"]
        MasteryBoard["Topic Atlas, Knowledge Points, Practice Cards"]
        SettingsNav["Settings Navigation, Section Registry, Provider Workspace"]
    end

    subgraph StateLayer ["State and Data Layer"]
        ChatRuntimeState["ChatRuntime (WebSocket turn protocol, streaming)"]
        KnowledgeAdapter["Knowledge Adapter (document selection, RAG queries)"]
        SessionStore["Session Store (list, archive, restore, delete)"]
        SettingsStore["SettingsStore (provider catalog, appearance, tools)"]
        AppShellContext["AppShellContext (active session, sidebar, panels)"]
        i18n["i18next (English catalog, t() wrappers)"]
    end

    subgraph LibLayer ["Library Layer"]
        SessionAPI["session-api.ts (REST client)"]
        SessionArchive["session-archive.ts (archive bucketing and filter)"]
        LearningAPI["learning-api.ts (mastery index, topic CRUD)"]
        ReadingAPI["reading-workspace-api.ts (collections, annotations)"]
        ApiFetch["apiFetch.ts (auth boundary, retry, error normalization)"]
        StreamProtocol["stream-protocol.ts (v2 event codec, reconnect, replay)"]
    end

    AppRouter --> UILayer
    UILayer --> StateLayer
    StateLayer --> LibLayer
    LibLayer -->|"REST + WSS"| Backend["FastAPI Backend"]
```

---

## Backend Agentic Turn Pipeline

```mermaid
graph LR
    subgraph Inbound ["Request Ingestion"]
        WS["WebSocket /api/v2/turns"]
        REST["REST /api/* endpoints"]
    end

    subgraph TurnPipeline ["Agentic Turn Engine"]
        Launcher["launcher.py: Turn Launcher"]
        Orchestrator["orchestrator.py: Capability Router"]
        BaseAgent["base_agent.py: ReAct Loop Core"]
        CapabilityReg["capability_catalog.py + registry.py"]
    end

    subgraph Capabilities ["Registered Capabilities"]
        ExploreCtx["explore_context: Open Q and A"]
        CourseStudy["course_study: Document-Grounded Chat"]
        Reading["reading: Reading Workspace Sessions"]
        Mastery["mastery: Mastery Learning Path"]
        Solve["solve: Step-by-Step Problem Solving"]
        AskQuestions["ask_questions: Interactive Quizzes"]
    end

    subgraph Agents ["Specialized Agent Loops"]
        ChatAgent["chat/ agent: Primary Tutor"]
        VisualizeAgent["visualize/ agent: Visualizer Synthesis"]
        ResearchAgent["research/ agent: Multi-Source Research"]
        QuestionAgent["question/ agent: Quiz Generation"]
        NotebookAgent["notebook/ agent: Note Compilation"]
        VisionAgent["vision_solver/ agent: Image Analysis"]
        MathAnimator["math_animator/ agent: Manim Rendering"]
    end

    subgraph ToolBelt ["Tool Registry"]
        WebSearch["web_search.py + web_fetch.py"]
        PaperSearch["paper_search_tool.py (ArXiv)"]
        RAGTool["rag_tool.py"]
        AskUser["ask_user.py (Interactive Choice Cards)"]
        ExecTool["exec_tool.py (Sandboxed Code Exec)"]
        MasteryNav["mastery_nav.py"]
        QuestionBank["question_bank.py"]
        WriteNote["write_note.py"]
        MediaGen["media_gen_tool.py"]
        Workspace["workspace.py"]
    end

    WS --> Launcher
    REST --> Launcher
    Launcher --> Orchestrator
    Orchestrator --> CapabilityReg
    CapabilityReg --> Capabilities
    Capabilities --> BaseAgent
    BaseAgent --> Agents
    Agents --> ToolBelt
```

---

## RAG and Knowledge Indexing Pipeline

```mermaid
graph TD
    subgraph Ingestion ["Document Ingestion"]
        Upload["File Upload (PDF, EPUB, DOCX, XLSX, PPTX, MD)"]
        AddDocs["add_documents.py: Chunking and Metadata Extraction"]
        Parsers["Parsing Layer (PyMuPDF, python-docx, openpyxl, python-pptx, pdfplumber)"]
    end

    subgraph Indexing ["Index Construction"]
        KBManager["knowledge/manager.py: Knowledge Base Lifecycle"]
        IndexRun["indexing_run.py: Batch Index Build"]
        Manifest["manifest.py: Document Manifest and Versioning"]
        EmbeddingBind["rag/embedding_binding.py: Model-Aware Embeddings"]
        IndexVersion["rag/index_versioning.py: Signature-Based Cache"]
    end

    subgraph Retrieval ["Hybrid Retrieval"]
        SmartRetriever["smart_retriever.py: Hybrid Dense + BM25"]
        FAISS["FAISS Vector Store"]
        BM25["BM25 Keyword Index"]
        LinkedKB["linked_kb.py: Cross-KB Federation"]
    end

    subgraph Citation ["Citation Resolution"]
        SourceVisuals["source_visuals.py: Page-Level Citation Badges"]
        VisualCoverage["visual_coverage.py: Coverage Scoring"]
        VisualAssets["visual_assets.py: Document Visual Extraction"]
    end

    Upload --> AddDocs
    AddDocs --> Parsers
    Parsers --> KBManager
    KBManager --> IndexRun
    IndexRun --> Manifest
    IndexRun --> EmbeddingBind
    EmbeddingBind --> IndexVersion

    IndexVersion --> FAISS
    IndexVersion --> BM25

    SmartRetriever --> FAISS
    SmartRetriever --> BM25
    SmartRetriever --> LinkedKB

    SmartRetriever --> SourceVisuals
    SourceVisuals --> VisualCoverage
    SourceVisuals --> VisualAssets
```

---

## Memory Hierarchy (L1 to L3)

```mermaid
graph TD
    subgraph L1 ["L1: Working Memory (Per-Turn)"]
        TurnCtx["Active Turn Context"]
        ToolResults["Tool Call Results"]
        StreamEvents["Streaming Event Buffer"]
    end

    subgraph L2 ["L2: Session Memory"]
        SessionHistory["Conversation History (SQLite)"]
        Consolidator["consolidator/: Summarization and Compaction"]
        Recall["recall.py: Semantic Recall"]
        Trace["trace.py: Execution Trace Snapshots"]
    end

    subgraph L3 ["L3: Persistent Memory"]
        Snapshot["snapshot/: Entity Extraction and Storage"]
        MemoryStore["store.py: Durable Memory Documents"]
        MemoryOps["ops.py: CRUD Operations"]
        Settings["settings.py: Memory Policies and Budgets"]
    end

    L1 -->|"Turn completion"| L2
    L2 -->|"Session end / consolidation"| L3
    L3 -->|"Recall injection"| L1
```

---

## Multi-User Identity and Access Control

```mermaid
graph TD
    subgraph Auth ["Authentication Layer"]
        PBClient["pocketbase_client.py: OAuth and Email Auth"]
        CodexAuth["codex_auth/: OpenAI Codex OAuth Flow"]
        CodeBuddyAuth["codebuddy_auth.py: Partner Token Validation"]
    end

    subgraph Identity ["Identity Resolution"]
        IdentityMod["identity.py: User Identity Resolution"]
        ContextMod["context.py: Request-Scoped User Context"]
        Models["models.py: User, Account, Role Schemas"]
    end

    subgraph Grants ["Access Control"]
        GrantsMod["grants.py: Permission Grants Engine"]
        Guardians["guardians.py: Guardian-Learner Relationships"]
        LearnerProfile["learner_profile.py: Adaptive Profile"]
        ModelAccess["model_access.py: Per-User Model Quotas"]
        KBAccess["knowledge_access.py: KB Visibility Scoping"]
        ToolAccess["tool_access.py: Tool Availability Filtering"]
        SkillAccess["skill_access.py: Capability Gating"]
    end

    subgraph Paths ["Data Isolation"]
        PathsMod["paths.py: Per-User Filesystem Boundaries"]
        Handoff["session_handoff.py: Cross-User Session Transfer"]
        Audit["audit.py: Access Audit Logging"]
    end

    Auth --> Identity
    Identity --> Grants
    Grants --> Paths
```

---

## Sandbox and Code Execution Isolation

```mermaid
graph LR
    subgraph MainApp ["EAS Main Container"]
        ExecTool["exec_tool.py: Code Execution Request"]
        SandboxConfig["sandbox/config.py: Backend Selection"]
    end

    subgraph SandboxSidecar ["Sandbox Runner Sidecar"]
        RunnerServer["HTTP Server (Port 8900, internal only)"]
        UnprivUser["Unprivileged runner user"]
        ReadOnlyFS["Read-Only Root Filesystem"]
        TmpFS["/tmp and /home/runner tmpfs"]
        PIDLimit["PID Limit: 256"]
        MemLimit["Memory Limit: 1 GB"]
    end

    subgraph SecurityPolicy ["Security Hardening"]
        NoNewPriv["no-new-privileges: true"]
        CapDropAll["cap_drop: ALL"]
        NoHostPorts["No published host ports"]
        ROWorkspace["Workspace: read-only mount"]
        RWOutputs["Only /workspace/outputs is writable"]
    end

    ExecTool -->|"HTTP POST"| SandboxConfig
    SandboxConfig -->|"http://sandbox-runner:8900"| RunnerServer
    RunnerServer --> UnprivUser
    UnprivUser --> ReadOnlyFS
    ReadOnlyFS --> TmpFS
    SecurityPolicy -.-> SandboxSidecar
```

---

## Docker Service Orchestration

```mermaid
graph TD
    subgraph Compose ["docker-compose.yml"]
        RedisService["redis: Redis 7.4 Alpine<br/>Port: 6379 (internal)<br/>AOF persistence"]
        PocketBaseService["pocketbase: Auth Sidecar<br/>Port: 8090 (host-mapped)<br/>OAuth + Email signup"]
        EASService["eas: All-in-One Application<br/>Ports: 8001 (API), 3782 (Web)<br/>FastAPI + Next.js"]
        SandboxService["sandbox-runner: Isolated Exec<br/>Port: 8900 (internal only)<br/>Unprivileged, read-only"]
    end

    subgraph Volumes ["Persistent Volumes"]
        DataLocal["./data-eas-local:/app/data"]
        RedisData["./data-eas-local/redis:/data"]
        PBData["./data-eas-local/pocketbase:/pb_data"]
        WorkspaceVol["EAS_WORKSPACE_HOST:/workspace"]
    end

    subgraph Network ["eas-network (bridge)"]
        InternalDNS["Service discovery via container names"]
    end

    RedisService -->|"service_healthy"| EASService
    PocketBaseService -->|"service_healthy"| EASService
    SandboxService -->|"service_healthy"| EASService

    EASService --> DataLocal
    EASService --> WorkspaceVol
    RedisService --> RedisData
    PocketBaseService --> PBData
    SandboxService -->|"read-only"| WorkspaceVol
```

---

## Data and Request Flow

```mermaid
sequenceDiagram
    participant L as Learner
    participant FE as Next.js Frontend
    participant GW as FastAPI Gateway
    participant TE as Turn Engine
    participant CAP as Capability Router
    participant AG as Agent Loop
    participant TL as Tool Registry
    participant RAG as RAG Retriever
    participant LLM as LLM Provider
    participant SB as Sandbox Runner
    participant DB as SQLite + Redis

    L->>FE: Ask question or upload document
    FE->>GW: WebSocket turn command (v2 protocol)
    GW->>TE: Launch turn
    TE->>CAP: Route to capability
    CAP->>AG: Initialize agent loop
    AG->>LLM: Generate with system prompt + context
    LLM-->>AG: Streaming response (text + tool calls)

    alt Tool call: RAG retrieval
        AG->>TL: Dispatch rag_tool
        TL->>RAG: Hybrid query (dense + BM25)
        RAG-->>TL: Ranked passages + citation coords
        TL-->>AG: Grounded context
    end

    alt Tool call: Code execution
        AG->>TL: Dispatch exec_tool
        TL->>SB: HTTP POST to sandbox-runner
        SB-->>TL: stdout, stderr, exit code
        TL-->>AG: Execution result
    end

    alt Tool call: Visualizer synthesis
        AG->>TL: Dispatch visualize
        TL-->>AG: HTML/SVG/Canvas artifact
    end

    AG-->>GW: Stream events (text chunks, tool results, artifacts)
    GW-->>FE: WebSocket stream (v2 event frames)
    FE-->>L: Rendered response with visuals and citations

    AG->>DB: Persist turn to session history
    AG->>DB: Update memory snapshots
```

---

## Tech Stack and Codebase Structure

EAS is built as a full-stack monorepo with a clean separation between a Python backend and a TypeScript frontend, both living under `apps/eas/`.

**Backend (Python 3.11+, FastAPI):** The core is organized around a capability-driven agent architecture. The `eas/` Python package contains isolated modules for each domain: `agents/` holds the ReAct loop implementations for chat, research, visualization, and quiz generation; `capabilities/` maps learning scenarios (open exploration, document study, mastery paths) to the appropriate agent and tool set; `services/` provides infrastructure like the LLM provider registry, RAG pipelines, embedding management, memory consolidation, and session persistence; `runtime/` handles turn orchestration, Redis-backed event streaming, and worker coordination; and `learning/` implements the adaptive tutoring policies, spaced repetition scheduler, and mastery state machine. This modular layout means each subsystem can be tested and evolved independently, as validated by the 1,000+ backend test suite.

**Frontend (Next.js 16, React 19, TypeScript 5):** The web application uses the App Router with route groups to separate public landing pages, authenticated workspaces, settings, and admin surfaces. A strict three-layer architecture governs the codebase: `app/` contains only route definitions and page-level data fetching; `components/` and `features/` hold reusable UI primitives and domain-specific feature modules; `lib/` provides API clients, state adapters, and protocol codecs. All communication with the backend goes through a single `apiFetch` boundary that handles authentication, retry logic, and error normalization. Real-time streaming uses a custom v2 WebSocket protocol with sequence tracking, reconnect recovery, and durable replay.

**Storage:** Session data, vector indices, and metadata live in SQLite for zero-configuration portability. Redis 7.4 handles ephemeral coordination: event streaming, turn state, and singleflight caches. PocketBase provides optional OAuth and email authentication. The filesystem holds uploaded documents and workspace artifacts.

**Security:** Untrusted code execution is fully isolated in a dedicated sandbox runner sidecar. The runner container drops all Linux capabilities, runs read-only, enforces PID and memory limits, and is never exposed to the host network. The main application container never runs user-supplied code in its own process.

**Maintainability:** Architectural boundaries are enforced by automated dependency cruising (688 modules, 2,075 dependency edges, zero violations) and a comprehensive verification pipeline covering TypeScript type safety, ESLint, i18n catalog parity, API contract generation, and 1,036 frontend unit tests alongside the backend suite. Every settings page, tool registration, and capability binding follows a declarative registry pattern, making it straightforward to add new features without touching core orchestration code.
