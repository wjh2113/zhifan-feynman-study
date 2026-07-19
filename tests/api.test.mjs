import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import JSZip from "jszip";

const port = 20_000 + Math.floor(Math.random() * 10_000);
const baseUrl = `http://127.0.0.1:${port}`;
const ragProjectId = `rag-test-${port}`;
let server;
let visionMock;
let visionMockUrl;
let serverError = "";
let uploadedSources = [];

function createBlankPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 3 >>\nstream\nq\nQ\nendstream"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "ascii");
}

async function createDocxWithScreenshot(png) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="png" ContentType="image/png"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>课堂正文：以下截图记录访谈结论。</w:t></w:r></w:p><w:sectPr/></w:body>
    </w:document>`);
  zip.folder("word").folder("media").file("screenshot.png", png);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function waitForServer() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`测试服务器提前退出：${serverError || `exit ${server.exitCode}`}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("测试服务器未能按时启动");
}

before(async () => {
  visionMock = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/models") {
      response.end(JSON.stringify({ data: [{ id: "mock-vision" }] }));
      return;
    }
    if (request.url === "/chat/completions") {
      response.end(JSON.stringify({
        choices: [{ message: { content: "截图标题：用户访谈结论。关键发现：先验证最危险的假设。" } }]
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => visionMock.listen(0, "127.0.0.1", resolve));
  visionMockUrl = `http://127.0.0.1:${visionMock.address().port}`;

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DEEPSEEK_API_KEY: "",
      PGLITE_MEMORY: "true",
      DATA_DIR: `.data-test-${port}`
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stderr.on("data", (chunk) => {
    serverError += chunk.toString();
  });
  await waitForServer();
});

after(async () => {
  if (server && !server.killed) server.kill();
  if (visionMock) await new Promise((resolve) => visionMock.close(resolve));
  await rm(`.data-test-${port}`, { recursive: true, force: true });
});

test("健康检查返回模型与演示模式状态", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.model, "deepseek-v4-pro");
  assert.equal(data.configured, false);
  assert.equal(data.database.mode, "pglite");
  assert.equal(data.embedding.provider, "local-hash");
});

test("模型配置接口不会向前端返回明文密钥", async () => {
  const response = await fetch(`${baseUrl}/api/settings/model`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.provider, "DeepSeek");
  assert.equal(data.model, "deepseek-v4-pro");
  assert.equal(data.configured, false);
  assert.equal("apiKey" in data, false);

  const testResponse = await fetch(`${baseUrl}/api/settings/model/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(testResponse.status, 400);
});

test("项目数据会写入 PostgreSQL 并可重新读取", async () => {
  const project = {
    id: ragProjectId,
    title: "持久化测试项目",
    mode: "course",
    createdAt: Date.now(),
    progress: 8,
    analysis: { summary: "", highValue: [], modules: [], tacitKnowledge: [], scenarios: [], sources: [] },
    blindspots: [],
    sessions: [],
    onePager: null
  };
  const saved = await fetch(`${baseUrl}/api/projects/${ragProjectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project)
  });
  assert.equal(saved.status, 200);

  const response = await fetch(`${baseUrl}/api/projects`);
  const data = await response.json();
  assert.ok(data.projects.some((item) => item.id === ragProjectId && item.title === "持久化测试项目"));
});

test("TXT 与 Markdown 资料可上传并生成知识骨架", async () => {
  const body = new FormData();
  body.append(
    "files",
    new Blob(["反馈闭环需要把用户修改转化为可学习的信号。"], { type: "text/plain" }),
    "课堂笔记.txt"
  );
  body.append(
    "files",
    new Blob(["# 最小验证\n先验证最危险的假设，再增加投入。"], { type: "text/markdown" }),
    "个人笔记.md"
  );
  body.append("title", "AI 产品方法");
  body.append("mode", "course");
  body.append("projectId", ragProjectId);

  const response = await fetch(`${baseUrl}/api/analyze`, { method: "POST", body });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.demo, true);
  assert.equal(data.sources.length, 2);
  uploadedSources = data.sources;
  assert.equal(data.sources[0].name, "课堂笔记.txt");
  assert.ok(data.sources[0].chunks >= 1);
  assert.match(data.sources[0].summary.summary, /反馈闭环|用户修改/);
  assert.match(data.sources[0].parsedPreview, /反馈闭环/);
  assert.equal(data.sources[0].parseReport.nativeCharacters > 0, true);
  assert.match(data.sources[0].downloadUrl, /\/api\/documents\//);
  assert.ok(data.retrieval.chunks >= 2);
  assert.ok(data.modules.length >= 3);
  assert.ok(data.modules.flatMap((module) => module.concepts).length >= 5);
  assert.ok(data.questions.length >= 5);
  assert.match(data.questions[0].question, /解释|例子|什么情况下|如何|比较/);
  assert.ok(data.questions[0].concept);
});

test("图片资料会调用视觉模型 OCR，并把识别结果写入总结和检索分块", async () => {
  const savedVision = await fetch(`${baseUrl}/api/settings/vision`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseUrl: visionMockUrl,
      model: "mock-vision",
      apiKey: "vision-test-secret"
    })
  });
  assert.equal(savedVision.status, 200);
  const publicConfig = await savedVision.json();
  assert.equal(publicConfig.configured, true);
  assert.equal(JSON.stringify(publicConfig).includes("vision-test-secret"), false);

  const connection = await fetch(`${baseUrl}/api/settings/vision/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(connection.status, 200);
  assert.equal((await connection.json()).modelAvailable, true);

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlS8AAAAASUVORK5CYII=",
    "base64"
  );
  const body = new FormData();
  body.append("files", new Blob([png], { type: "image/png" }), "课堂截图.png");
  body.append("title", "截图 OCR 测试");
  body.append("projectId", `ocr-test-${port}`);
  const response = await fetch(`${baseUrl}/api/analyze`, { method: "POST", body });
  assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json();
  assert.equal(data.sources.length, 1);
  assert.equal(data.sources[0].parseReport.ocrStatus, "ready");
  assert.equal(data.sources[0].parseReport.imagesOcrd, 1);
  assert.match(data.sources[0].parsedPreview, /用户访谈结论/);
  assert.match(data.sources[0].summary.summary, /用户访谈结论/);
  assert.ok(data.sources[0].chunks >= 1);

  const pdfBody = new FormData();
  pdfBody.append("files", new Blob([createBlankPdf()], { type: "application/pdf" }), "扫描讲义.pdf");
  pdfBody.append("title", "PDF OCR 测试");
  pdfBody.append("projectId", `pdf-ocr-test-${port}`);
  const pdfResponse = await fetch(`${baseUrl}/api/analyze`, { method: "POST", body: pdfBody });
  assert.equal(pdfResponse.status, 200, await pdfResponse.clone().text());
  const pdfData = await pdfResponse.json();
  assert.equal(pdfData.sources[0].parseReport.ocrStatus, "ready");
  assert.equal(pdfData.sources[0].parseReport.imagesOcrd, 1);
  assert.match(pdfData.sources[0].parsedPreview, /最危险的假设/);

  const docxBody = new FormData();
  docxBody.append(
    "files",
    new Blob([await createDocxWithScreenshot(png)], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }),
    "含截图课堂笔记.docx"
  );
  docxBody.append("title", "DOCX 截图 OCR 测试");
  docxBody.append("projectId", `docx-ocr-test-${port}`);
  const docxResponse = await fetch(`${baseUrl}/api/analyze`, { method: "POST", body: docxBody });
  assert.equal(docxResponse.status, 200, await docxResponse.clone().text());
  const docxData = await docxResponse.json();
  assert.equal(docxData.sources[0].parseReport.imagesFound, 1);
  assert.equal(docxData.sources[0].parseReport.imagesOcrd, 1);
  assert.match(docxData.sources[0].parsedPreview, /课堂正文/);
  assert.match(docxData.sources[0].parsedPreview, /用户访谈结论/);

  const cleared = await fetch(`${baseUrl}/api/settings/vision`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clearApiKey: true })
  });
  assert.equal(cleared.status, 200);
});

test("原始资料会落盘并可通过受控接口重新下载", async () => {
  const response = await fetch(`${baseUrl}${uploadedSources[0].downloadUrl}`);
  const content = await response.text();
  assert.equal(response.status, 200, content);
  assert.match(content, /反馈闭环需要把用户修改转化为可学习的信号/);
});

test("混合检索会返回持久化资料的原文与页码", async () => {
  const response = await fetch(`${baseUrl}/api/rag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: ragProjectId,
      query: "用户修改如何变成反馈信号？"
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.retrieval, "hybrid");
  assert.ok(data.sources.length >= 1);
  assert.match(data.sources.map((item) => item.quote).join(" "), /反馈|用户修改/);
  assert.ok(data.sources[0].documentId);
  assert.ok(data.sources[0].page >= 1);
});

test("不支持的文件格式返回明确错误", async () => {
  const body = new FormData();
  body.append("files", new Blob(["fake"], { type: "application/octet-stream" }), "资料.exe");
  body.append("title", "错误格式");
  const response = await fetch(`${baseUrl}/api/analyze`, { method: "POST", body });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /暂不支持/);
});

test("费曼教练会针对黑话追问", async () => {
  const response = await fetch(`${baseUrl}/api/coach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: {
        id: "q-data-loop",
        question: "请不用专业术语解释数据飞轮为什么会运转。",
        concept: "数据飞轮"
      },
      concept: { title: "数据飞轮" },
      answer: "它能赋能业务并形成闭环。",
      role: "child",
      turn: 1
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.demo, true);
  assert.match(data.reply, /赋能|闭环/);
  assert.ok(data.evaluation.clarity < 70);
});

test("费曼教练能识别例子并追问边界", async () => {
  const response = await fetch(`${baseUrl}/api/coach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      concept: { title: "能力边界" },
      answer: "比如客服机器人遇到退款争议时，需要交给人工确认。",
      role: "child",
      turn: 1
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.reply, /什么情况下/);
  assert.ok(data.evaluation.example >= 80);
});

test("空回答会被拒绝", async () => {
  const response = await fetch(`${baseUrl}/api/coach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: "   " })
  });
  assert.equal(response.status, 400);
});

test("可以从项目数据生成一页纸", async () => {
  const response = await fetch(`${baseUrl}/api/one-pager`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: {
        title: "AI 产品方法",
        analysis: { summary: "先验证问题，再设计方案。", highValue: ["问题定义", "最小验证", "反馈闭环"] }
      }
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.title, "AI 产品方法");
  assert.equal(data.takeaways.length, 3);
  assert.equal(data.demo, true);
});

test("API Key 可持久化、脱敏显示并清除", async () => {
  const saveResponse = await fetch(`${baseUrl}/api/settings/model`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "sk-test-secret-12345678"
    })
  });
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json();
  assert.equal(saved.configured, true);
  assert.match(saved.apiKeyMasked, /^sk-t.*5678$/);
  assert.equal(JSON.stringify(saved).includes("sk-test-secret-12345678"), false);

  const clearResponse = await fetch(`${baseUrl}/api/settings/model`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clearApiKey: true })
  });
  assert.equal(clearResponse.status, 200);
  assert.equal((await clearResponse.json()).configured, false);
});
