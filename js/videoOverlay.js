// Texto "queimado" nos pixels do vídeo gravado (data/hora ao vivo + linhas
// de identificação) — prova, numa disputa no Mercado Livre, de que o vídeo é
// daquele pedido/devolução e não foi editado (relógio corre a cada quadro).
// Usado por pages/embalagem.html (conferência) e pages/devolucoes.html
// (gravação da devolução). Ver .claude/embalagem.md.
//
// iniciar(): desenha a câmera num <canvas> a cada quadro + barra preta com o
// texto, e devolve o stream do canvas com o áudio original — é ele que vai
// pro MediaRecorder. Se o navegador não suportar captureStream, o chamador
// cai pra câmera crua (try/catch), como a Embalagem já fazia.
(function () {
  function desenhar(video, canvas, ctx, linhas) {
    const w = canvas.width, h = canvas.height;
    ctx.drawImage(video, 0, 0, w, h);
    const fonte = Math.max(14, Math.round(w / 46));
    const padV = Math.round(fonte * 0.5);
    const textos = [new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }), ...linhas];
    const barH = textos.length * (fonte + padV) + padV;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, w, barH);
    ctx.font = `700 ${fonte}px -apple-system, Arial, sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'top';
    textos.forEach((t, i) => ctx.fillText(t, padV, padV + i * (fonte + padV)));
  }

  // video: <video> tocando a câmera; audioTracks: faixas de áudio a manter;
  // linhas: textos fixos abaixo da data/hora. → { stream, parar() }
  function iniciar(video, audioTracks, linhas, fps = 25) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    let raf = null;
    const loop = () => { desenhar(video, canvas, ctx, linhas); raf = requestAnimationFrame(loop); };
    loop();
    const canvasStream = canvas.captureStream(fps);
    return {
      stream: new MediaStream([...canvasStream.getVideoTracks(), ...(audioTracks || [])]),
      parar() { if (raf) cancelAnimationFrame(raf); raf = null; canvasStream.getTracks().forEach(t => t.stop()); },
    };
  }

  window.VideoOverlay = { desenhar, iniciar };
})();
