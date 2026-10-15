import { Color3, DynamicTexture, Mesh, MeshBuilder, PointerEventTypes, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { GRANDEZA_POR_ID } from "../config/grandezas.js";
import { ESTADOS } from "../config/estados.js";
import { desenharIcone, svgIcone } from "../util/icones.js";
import { textoValor } from "../ui/sensoresUI.js";
import { criarEmissor } from "../util/emissor.js";

// Compartimentos com sensores: o sensor de corrente fica no painel elétrico (pedestal do lado do cabeçote);
// temperatura, vibração, nível de óleo e rotação ficam na caixa lateral de engrenagens do cabeçote.
// As tampas são as do próprio torno.glb, giradas em dobradiças em tempo de execução (o arquivo não muda).
// Coordenadas em metros, como no torno.glb; `dobradica` = eixo vertical (x, z); `sensores[].pos` = (z, y)
// na face aberta e `etiqueta` = deslocamento (z, y) da etiqueta; `angulo` em graus (negativo abre para fora, -X).
// Olhando a lateral do cabeçote, -Z fica à esquerda (lado das dobradiças) e +Z à direita (lado do operador).
// O interior da caixa segue a foto da máquina real: polia laranja em cima à esquerda com o sensor de rotação
// logo abaixo, ponta do eixo-árvore em cima ao centro, trem de engrenagens à direita e placa guardada embaixo.
export const COMPARTIMENTOS = [
  {
    id: "caixaEngrenagens",
    nome: "Caixa lateral de engrenagens",
    componente: "cabecote",
    tampa: /^(Porta_lateral_cabecote|Fecho_lateral)/,
    dobradica: [-1.4205, -0.2495], // as dobradiças do modelo (Dobradica_porta)
    angulo: -105,
    face: -1.4015, // logo à frente da face do cabeçote (x = -1,400)
    abertura: { z: [-0.29, 0.29], y: [0.71, 1.31] },
    fundo: desenharEngrenagens,
    porta: desenharDocumento, // folha de manutenção no lado de dentro da tampa
    sensores: [
      { grandeza: "temperatura", tipo: "termometro", pos: [0.045, 1.215], etiqueta: [0.1, 0.075] },
      { grandeza: "vibracao", tipo: "acelerometro", pos: [-0.055, 1.235], etiqueta: [-0.1, 0.08] },
      { grandeza: "rotacao", tipo: "indutivo", pos: [-0.2, 1.03], etiqueta: [0.02, -0.12] },
      { grandeza: "oleo", tipo: "nivel", pos: [0.215, 0.8], etiqueta: [-0.04, 0.1] },
    ],
  },
  {
    id: "painelEletrico",
    nome: "Painel elétrico",
    componente: "base",
    tampa: /^(Gabinete_motor_lateral|Veneziana_motor)/,
    dobradica: [-1.403, -0.335], // borda traseira da tampa
    angulo: -105,
    face: -1.392, // entre a tampa e o pedestal (x = -1,390)
    abertura: { z: [-0.32, 0.25], y: [0.1, 0.515] },
    fundo: desenharPainelEletrico,
    sensores: [{ grandeza: "corrente", tipo: "tc", pos: [0.12, 0.26], etiqueta: [0, 0.075] }],
  },
];

// Vista da câmera com as tampas abertas (lado do cabeçote, pela frente).
const VISTA = { alvo: [-1.42, 0.72, 0], alfa: Math.PI - 0.5, beta: 1.3, raio: 2.3 };
const LARGURA_ETIQUETA = 0.15; // m
const ALTURA_ETIQUETA = 0.056;

/**
 * Antes de criarSelecao: dá às tampas uma cópia própria de cada material, para a mescla de malhas
 * (que junta peças do mesmo componente e material) não fundir a tampa com o corpo da máquina.
 * A aparência não muda.
 */
export function separarTampas(modelo) {
  return COMPARTIMENTOS.map((c) => {
    const copias = new Map();
    for (const m of modelo.malhas) {
      if (!c.tampa.test(m.name) || !m.material) continue;
      if (!copias.has(m.material)) copias.set(m.material, m.material.clone(`${m.material.name}__${c.id}`));
      m.material = copias.get(m.material);
    }
    return { ...c, materiais: new Set(copias.values()) };
  });
}

/**
 * Painel elétrico e tampa da caixa de engrenagens que se abrem com a mão: arrastar a tampa (mouse, dedo ou,
 * no headset, pinça / gatilho apontando para ela) gira na dobradiça; clicar ou tocar abre ou fecha; o botão
 * Sensores abre ou fecha as duas e leva a câmera até elas. Dentro aparecem os sensores instalados, com LED e
 * etiqueta na cor do estado da medição; clicar num sensor abre a medição dele.
 * Chamar depois de prepararMalhas (que congela as peças fixas). Emite "estado" (alguma tampa aberta).
 */
export function criarCompartimentos({ scene, camera, selecao, tampas, fluxo, config, focar, aoAbrirGrandeza }) {
  const eventos = criarEmissor();
  const botao = document.getElementById("btn-sensores");
  botao?.insertAdjacentHTML("afterbegin", svgIcone("porta"));
  const rad = (graus) => (graus * Math.PI) / 180;
  let abertoAntes = false;

  const comps = tampas.map((c) => {
    // tampa presa a uma dobradiça (as malhas continuam identificadas pelo componente de antes)
    const eixo = new TransformNode(`dobradica_${c.id}`, scene);
    eixo.position.set(c.dobradica[0], 0, c.dobradica[1]);
    const malhasTampa = selecao.malhas.filter((m) => c.materiais.has(m.material));
    for (const m of malhasTampa) {
      m.unfreezeWorldMatrix();
      m.setParent(eixo);
    }
    const interior = criarInterior(scene, c);
    if (c.porta) {
      // lado de dentro da tampa (voltado para +X com a tampa fechada): gira junto com ela
      const doc = planoDesenhado(scene, `documento_${c.id}`, 0.2, 0.27, c.porta, 256);
      doc.parent = eixo; // posição relativa à dobradiça (ainda sem rotação)
      doc.rotation.y = -Math.PI / 2;
      doc.position.set(-1.3985 - c.dobradica[0], 0.95, 0.02 - c.dobradica[1]);
      interior.extras.push(doc);
    }
    interior.raiz.setEnabled(false);
    for (const m of interior.extras) m.setEnabled(false);
    const abrirMedicao = (id) => () => {
      selecao.selecionar(c.componente);
      aoAbrirGrandeza?.(id);
    };
    for (const s of interior.sensores) {
      for (const m of s.malhas) selecao.registrarClicavel(m, abrirMedicao(s.id), selecao.porId(c.componente));
    }
    // k = quanto está aberta (0 fechada, 1 aberta); alvo = para onde vai quando ninguém está segurando
    return { ...c, eixo, interior, malhasTampa, k: 0, kAplicado: -1, alvo: 0, segurando: false };
  });
  const sensores = comps.flatMap((c) => c.interior.sensores);

  // ---------- clicar / tocar na tampa abre ou fecha; passar o mouse destaca só a tampa
  for (const c of comps) {
    const dica = { id: `tampa_${c.id}`, nome: `${c.nome}: clique ou arraste a tampa`, malhas: c.malhasTampa };
    for (const m of c.malhasTampa) {
      selecao.registrarClicavel(m, () => definirTampa(c, c.alvo === 1 ? 0 : 1), dica);
    }
  }

  // ---------- arrastar (mouse, dedo, pinça ou gatilho no headset): a tampa acompanha o ponto agarrado,
  // girando na dobradiça. O ponto é a interseção do raio do ponteiro com o plano horizontal na altura
  // em que a tampa foi agarrada. (O PointerDragBehavior do Babylon põe esse plano na origem da malha,
  // que aqui fica longe da tampa, por isso o arrasto é feito à mão.)
  const anguloDe = (c, x, z) => Math.atan2(x - c.dobradica[0], z - c.dobradica[1]); // com a tampa a θ, um ponto dela está a θ
  let arrasto = null; // { c, pointerId, y, phi0, theta0, velocidade, moveu, cameraLigada }
  for (const c of comps) {
    for (const m of c.malhasTampa) {
      m.isNearGrabbable = true; // pegar com a mão no headset
      m.enablePointerMoveEvents = true; // destaque e dica ao passar o mouse sobre a tampa
    }
  }

  function pontoNoPlano(pi, y) {
    const raio = pi.pickInfo?.ray;
    if (raio && Math.abs(raio.direction.y) > 1e-4) {
      const t = (y - raio.origin.y) / raio.direction.y;
      if (t > 0) return [raio.origin.x + raio.direction.x * t, raio.origin.z + raio.direction.z * t];
    }
    const p = pi.pickInfo?.pickedPoint; // pegar de perto (mão) não traz raio, mas traz o ponto
    return p ? [p.x, p.z] : null;
  }

  scene.onPointerObservable.add((pi) => {
    if (pi.type === PointerEventTypes.POINTERDOWN && !arrasto) {
      const malha = pi.pickInfo?.hit ? pi.pickInfo.pickedMesh : null;
      const c = malha && comps.find((c) => c.malhasTampa.includes(malha));
      if (!c || !pi.pickInfo.pickedPoint) return;
      const p = pi.pickInfo.pickedPoint;
      // a câmera orbital para enquanto a tampa está sendo arrastada
      const cameraLigada = scene.activeCamera === camera && camera.inputs.attachedToElement;
      if (cameraLigada) camera.detachControl();
      arrasto = { c, pointerId: pi.event.pointerId, y: p.y, phi0: anguloDe(c, p.x, p.z), theta0: rad(c.angulo) * c.k, velocidade: 0, moveu: false, cameraLigada };
      c.segurando = true;
    } else if (pi.type === PointerEventTypes.POINTERMOVE && arrasto && pi.event.pointerId === arrasto.pointerId) {
      const a = arrasto;
      const xz = pontoNoPlano(pi, a.y);
      // com o raio quase rasante ao plano o ponto cai longe e o ângulo fica instável: ignora
      if (!xz || Math.hypot(xz[0] - a.c.dobradica[0], xz[1] - a.c.dobradica[1]) > 1.5) return;
      let d = anguloDe(a.c, xz[0], xz[1]) - a.phi0;
      d = ((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      const k = Math.min(1, Math.max(0, (a.theta0 + d) / rad(a.c.angulo)));
      a.velocidade = a.velocidade * 0.6 + (k - a.c.k) * 0.4;
      if (Math.abs(d) > rad(2)) a.moveu = true;
      a.c.k = k;
    } else if (pi.type === PointerEventTypes.POINTERUP && arrasto && pi.event.pointerId === arrasto.pointerId) {
      const a = arrasto;
      arrasto = null;
      a.c.segurando = false;
      if (a.cameraLigada) camera.attachControl(scene.getEngine().getRenderingCanvas(), true); // como em cena.js
      if (!a.moveu) return; // foi um clique: quem decide é o toque (abre ou fecha)
      // soltou: termina o movimento no sentido em que vinha; parada, vai para o lado mais próximo
      let alvo = a.c.k > 0.5 ? 1 : 0;
      if (a.velocidade > 0.002) alvo = a.c.k > 0.1 ? 1 : 0;
      else if (a.velocidade < -0.002) alvo = a.c.k < 0.9 ? 0 : 1;
      definirTampa(a.c, alvo);
    }
  });

  // ---------- a cada quadro: tampa vai até o alvo (sem ninguém segurando) e mostra o interior
  scene.onBeforeRenderObservable.add(() => {
    const dt = Math.min(0.25, scene.getEngine().getDeltaTime() / 1000);
    for (const c of comps) {
      if (!c.segurando && c.k !== c.alvo) {
        c.k += (c.alvo - c.k) * Math.min(1, dt * 7);
        if (Math.abs(c.alvo - c.k) < 0.002) c.k = c.alvo;
      }
      if (c.k === c.kAplicado) continue;
      c.kAplicado = c.k;
      c.eixo.rotation.y = rad(c.angulo) * c.k;
      c.interior.raiz.setEnabled(c.k > 0);
      // sensores e etiquetas só com a tampa bem aberta (antes disso atravessariam a tampa)
      c.interior.sensoresRaiz.setEnabled(c.k > 0.3);
      for (const m of c.interior.extras) m.setEnabled(c.k > 0);
    }
  });

  // ---------- estado das medições nos sensores (LED e etiqueta)
  function atualizarSensores() {
    for (const s of sensores) {
      const e = fluxo.estado(s.id);
      const tv = textoValor(config, s.id, e.valor);
      s.atualizar(ESTADOS[e.estado] ?? ESTADOS.semDados, tv);
    }
  }
  setInterval(() => comps.some((c) => c.k > 0) && atualizarSensores(), 250);

  // ---------- abrir / fechar
  const algumaAberta = () => comps.some((c) => c.alvo === 1);
  function definirTampa(c, alvo) {
    c.alvo = alvo;
    if (alvo) atualizarSensores();
    sincronizar();
  }
  function sincronizar() {
    const aberto = algumaAberta();
    botao?.setAttribute("aria-pressed", String(aberto));
    if (botao) botao.title = aberto ? "Fechar o painel elétrico e a tampa da caixa de engrenagens" : "Abrir o painel elétrico e a tampa da caixa de engrenagens e mostrar os sensores";
    if (aberto !== abertoAntes) eventos.emitir("estado", aberto);
    abertoAntes = aberto;
  }
  function definir(v, { focarCamera = v } = {}) {
    for (const c of comps) c.alvo = v ? 1 : 0;
    if (v) atualizarSensores();
    if (focarCamera && scene.activeCamera === camera) {
      // pelo caminho mais curto em volta do torno
      const giro = VISTA.alfa - camera.alpha;
      const alfa = camera.alpha + ((((giro + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      focar(new Vector3(...VISTA.alvo), VISTA.raio, { alfa, beta: VISTA.beta, duracao: 1100 });
    }
    sincronizar();
  }
  botao?.addEventListener("click", () => definir(!algumaAberta()));

  return {
    abrir: (opcoes) => definir(true, opcoes),
    fechar: () => definir(false),
    alternar: () => definir(!algumaAberta()),
    get aberto() {
      return algumaAberta();
    },
    on: eventos.on,
  };
}

// ---------- interior: fundo desenhado, moldura e sensores
function criarInterior(scene, c) {
  const raiz = new TransformNode(`interior_${c.id}`, scene);
  const [z0, z1] = c.abertura.z;
  const [y0, y1] = c.abertura.y;
  const largura = z1 - z0;
  const altura = y1 - y0;
  const zc = (z0 + z1) / 2;
  const yc = (y0 + y1) / 2;

  // fundo (plano voltado para -X, para quem olha a lateral do cabeçote); z → x do canvas, y → y do canvas
  const fundo = planoDesenhado(scene, `fundoInterior_${c.id}`, largura, altura, (ctx, w, h) =>
    c.fundo(ctx, w, h, (z) => ((z - z0) / largura) * w, (y) => ((y1 - y) / altura) * h),
  );
  fundo.rotation.y = Math.PI / 2;
  fundo.position.set(c.face, yc, zc);

  // moldura: espessura da carcaça em volta da abertura (rasa, para não atravessar a tampa fechada)
  const matMoldura = cor(scene, "#4a525c");
  const moldura = [
    [0.012, 0.014, largura + 0.028, yc + altura / 2 + 0.007, zc],
    [0.012, 0.014, largura + 0.028, yc - altura / 2 - 0.007, zc],
    [0.012, altura, 0.014, yc, z0 - 0.007],
    [0.012, altura, 0.014, yc, z1 + 0.007],
  ].map(([w, h, d, y, z]) => {
    const b = MeshBuilder.CreateBox("molduraInterior", { width: w, height: h, depth: d }, scene);
    b.position.set(c.face - w / 2, y, z);
    b.material = matMoldura;
    return b;
  });
  for (const m of [fundo, ...moldura]) {
    m.parent = raiz;
    m.isPickable = false;
  }

  const sensoresRaiz = new TransformNode(`sensores_${c.id}`, scene);
  sensoresRaiz.parent = raiz;
  const sensores = c.sensores.map((s) => criarSensor(scene, sensoresRaiz, c, s));
  return { raiz, sensoresRaiz, sensores, extras: [] };
}

/** Plano com imagem desenhada em canvas, sem sombreamento. */
function planoDesenhado(scene, nome, largura, altura, desenhar, px = 512) {
  const py = Math.round((px * altura) / largura);
  const tex = new DynamicTexture(`tex_${nome}`, { width: px, height: py }, scene, true);
  const ctx = tex.getContext();
  // na cena destra a face visível do plano mostra a imagem espelhada: desenha invertido na horizontal
  ctx.save();
  ctx.translate(px, 0);
  ctx.scale(-1, 1);
  desenhar(ctx, px, py);
  ctx.restore();
  tex.update();
  const mat = new StandardMaterial(`mat_${nome}`, scene);
  mat.diffuseTexture = tex;
  mat.disableLighting = true; // sem luzes, a cor final é emissiva × textura
  mat.emissiveColor = new Color3(0.92, 0.92, 0.92);
  const plano = MeshBuilder.CreatePlane(nome, { width: largura, height: altura }, scene);
  plano.material = mat;
  plano.isPickable = false;
  return plano;
}

const coresCache = new Map();
function cor(scene, hex, especular = 0.25) {
  const chave = `${hex}|${especular}`;
  if (!coresCache.has(chave)) {
    const m = new StandardMaterial(`sensor_${hex}`, scene);
    m.diffuseColor = Color3.FromHexString(hex);
    m.specularColor = new Color3(especular, especular, especular);
    coresCache.set(chave, m);
  }
  return coresCache.get(chave);
}

/** Corpo do sensor (geometria simples), LED de estado e etiqueta flutuante com valor. */
function criarSensor(scene, raiz, c, s) {
  const g = GRANDEZA_POR_ID[s.grandeza];
  const [z, y] = s.pos;
  const x = c.face;
  const metal = cor(scene, "#b8bec6", 0.6);
  const escuro = cor(scene, "#2b2f35");
  const cabo = cor(scene, "#16191d", 0.1);
  const malhas = [];
  const peca = (malha, material) => {
    malha.material = material;
    malha.parent = raiz;
    malhas.push(malha);
    return malha;
  };
  // cilindro deitado no eixo X (saindo da face), com a base em x
  const saindo = (nome, d, h, material, lados = 20, recuo = 0) => {
    const m = peca(MeshBuilder.CreateCylinder(nome, { diameter: d, height: h, tessellation: lados }, scene), material);
    m.rotation.z = Math.PI / 2;
    m.position.set(x - recuo - h / 2, y, z);
    return m;
  };

  let ponta = new Vector3(x - 0.04, y, z); // onde fica o LED
  if (s.tipo === "termometro") {
    saindo("sensorTemp", 0.026, 0.012, metal, 6);
    saindo("sensorTemp", 0.016, 0.034, cor(scene, "#d9dde2", 0.5), 20, 0.012);
    const fio = peca(MeshBuilder.CreateCylinder("caboTemp", { diameter: 0.007, height: 0.09 }, scene), cabo);
    fio.position.set(x - 0.04, y + 0.045, z);
    ponta = new Vector3(x - 0.047, y, z);
  } else if (s.tipo === "acelerometro") {
    saindo("sensorVib", 0.032, 0.008, metal, 6);
    saindo("sensorVib", 0.026, 0.034, cor(scene, "#cfd4da", 0.7), 24, 0.008);
    const conector = peca(MeshBuilder.CreateCylinder("sensorVib", { diameter: 0.012, height: 0.02 }, scene), escuro);
    conector.position.set(x - 0.025, y + 0.022, z);
    const fio = peca(MeshBuilder.CreateCylinder("caboVib", { diameter: 0.006, height: 0.07 }, scene), cabo);
    fio.position.set(x - 0.025, y + 0.065, z);
    ponta = new Vector3(x - 0.043, y, z);
  } else if (s.tipo === "indutivo") {
    // sensor cilíndrico em pé, logo abaixo da polia, com a face voltada para ela (como na máquina real)
    const xs = x - 0.026;
    const corpo = peca(MeshBuilder.CreateCylinder("sensorRot", { diameter: 0.034, height: 0.065, tessellation: 24 }, scene), metal);
    corpo.position.set(xs, y, z);
    const face = peca(MeshBuilder.CreateCylinder("sensorRot", { diameter: 0.03, height: 0.004, tessellation: 24 }, scene), cor(scene, "#d9822b", 0.2));
    face.position.set(xs, y + 0.0345, z);
    const porca = peca(MeshBuilder.CreateCylinder("sensorRot", { diameter: 0.044, height: 0.008, tessellation: 6 }, scene), metal);
    porca.position.set(xs, y + 0.018, z);
    const suporte = peca(MeshBuilder.CreateBox("sensorRot", { width: 0.026, height: 0.012, depth: 0.05 }, scene), escuro);
    suporte.position.set(x - 0.013, y + 0.018, z);
    const fio = peca(MeshBuilder.CreateCylinder("caboRot", { diameter: 0.008, height: 0.1 }, scene), cor(scene, "#2b7bd6", 0.2));
    fio.position.set(xs, y - 0.08, z);
    ponta = new Vector3(xs - 0.018, y - 0.012, z);
  } else if (s.tipo === "nivel") {
    // haste com boia mergulhada no banho de óleo
    const cabeca = peca(MeshBuilder.CreateBox("sensorNivel", { width: 0.03, height: 0.028, depth: 0.04 }, scene), escuro);
    cabeca.position.set(x - 0.022, y + 0.06, z);
    const haste = peca(MeshBuilder.CreateCylinder("sensorNivel", { diameter: 0.008, height: 0.13 }, scene), metal);
    haste.position.set(x - 0.022, y - 0.01, z);
    const boia = peca(MeshBuilder.CreateCylinder("sensorNivel", { diameter: 0.032, height: 0.024, tessellation: 24 }, scene), cor(scene, "#e8b400", 0.3));
    boia.position.set(x - 0.022, y - 0.04, z);
    ponta = new Vector3(x - 0.04, y + 0.06, z);
  } else if (s.tipo === "tc") {
    // transformador de corrente em volta do cabo de alimentação do motor
    const fio = peca(MeshBuilder.CreateCylinder("caboMotor", { diameter: 0.012, height: 0.32 }, scene), cabo);
    fio.position.set(x - 0.016, y + 0.04, z);
    const anel = peca(MeshBuilder.CreateTorus("sensorCorrente", { diameter: 0.042, thickness: 0.016, tessellation: 28 }, scene), escuro);
    anel.position.set(x - 0.016, y, z);
    const caixa = peca(MeshBuilder.CreateBox("sensorCorrente", { width: 0.018, height: 0.03, depth: 0.026 }, scene), escuro);
    caixa.position.set(x - 0.016, y, z - 0.034);
    const saida = peca(MeshBuilder.CreateCylinder("caboTC", { diameter: 0.005, height: 0.12 }, scene), cor(scene, "#f2f2f2", 0.1));
    saida.rotation.x = Math.PI / 2;
    saida.position.set(x - 0.016, y, z - 0.105);
    ponta = new Vector3(x - 0.026, y + 0.012, z - 0.034);
  }

  // LED de estado
  const matLed = new StandardMaterial(`ledSensor_${g.id}`, scene);
  matLed.disableLighting = true;
  const led = peca(MeshBuilder.CreateSphere(`ledSensor_${g.id}`, { diameter: 0.009, segments: 8 }, scene), matLed);
  led.position.copyFrom(ponta);

  // etiqueta (como os rótulos dos pontos instrumentados: sempre de frente para a câmera e por cima)
  const etiqueta = MeshBuilder.CreatePlane(`etiquetaSensor_${g.id}`, { width: LARGURA_ETIQUETA, height: ALTURA_ETIQUETA }, scene);
  etiqueta.parent = raiz;
  const [dz, dy] = s.etiqueta ?? [0, 0.07];
  etiqueta.position.set(x - 0.09, y + dy, z + dz);
  etiqueta.billboardMode = Mesh.BILLBOARDMODE_ALL;
  etiqueta.renderingGroupId = 1;
  const tex = new DynamicTexture(`texEtiquetaSensor_${g.id}`, { width: 320, height: 120 }, scene, true);
  tex.hasAlpha = true;
  const matEtiqueta = new StandardMaterial(`matEtiquetaSensor_${g.id}`, scene);
  matEtiqueta.diffuseTexture = tex;
  matEtiqueta.emissiveTexture = tex;
  matEtiqueta.useAlphaFromDiffuseTexture = true;
  matEtiqueta.disableLighting = true;
  matEtiqueta.backFaceCulling = false;
  etiqueta.material = matEtiqueta;
  malhas.push(etiqueta);

  // linha de chamada: da borda da etiqueta voltada para o sensor até o LED
  const borda = etiqueta.position.add(new Vector3(0, ((dy >= 0 ? -1 : 1) * ALTURA_ETIQUETA) / 2, 0));
  const linha = MeshBuilder.CreateLines(`linhaSensor_${g.id}`, { points: [borda, ponta] }, scene);
  linha.color = new Color3(0.85, 0.9, 0.95);
  linha.isPickable = false;
  linha.parent = raiz;

  let anterior = "";
  const sensor = {
    id: g.id,
    malhas,
    atualizar(estado, tv) {
      const chave = `${estado.id}|${tv.valor}|${tv.unidade}`;
      if (chave === anterior) return;
      anterior = chave;
      matLed.emissiveColor = Color3.FromHexString(estado.cor);
      desenharEtiqueta(tex.getContext(), g, estado, tv);
      tex.update();
    },
  };
  // desenha já na criação: textura nunca atualizada deixa a cena "não pronta" (whenReadyAsync não termina)
  sensor.atualizar(ESTADOS.semDados, { valor: "—", unidade: "" });
  return sensor;
}

function desenharEtiqueta(ctx, g, estado, tv) {
  const W = 320;
  const H = 120;
  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  ctx.roundRect(3, 3, W - 6, H - 6, 18);
  ctx.fillStyle = "rgba(17,24,33,0.93)";
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = estado.cor;
  ctx.stroke();
  desenharIcone(ctx, g.icone, 16, 12, 30, "#cfe3f7", 2.2);
  ctx.fillStyle = "#e9eef3";
  ctx.font = "600 24px Segoe UI, Roboto, Arial, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`Sensor de ${g.nome.toLowerCase()}`, 56, 28);
  ctx.textBaseline = "alphabetic";
  ctx.font = "700 44px Segoe UI, Roboto, Arial, sans-serif";
  ctx.fillStyle = estado.id === "semDados" ? "#8f99a3" : "#ffffff";
  ctx.fillText(tv.valor, 18, 98);
  const largura = ctx.measureText(tv.valor).width;
  ctx.font = "500 22px Segoe UI, Roboto, Arial, sans-serif";
  ctx.fillStyle = "#b9c4cf";
  ctx.fillText(tv.unidade, 18 + largura + 8, 98);
  ctx.font = "600 21px Segoe UI, Roboto, Arial, sans-serif";
  ctx.textAlign = "right";
  ctx.fillStyle = "#e9eef3";
  ctx.fillText(estado.texto, W - 16, 96);
  const larguraEstado = ctx.measureText(estado.texto).width;
  desenharIcone(ctx, estado.icone, W - 16 - larguraEstado - 30, 76, 24, estado.cor, 2.6);
}

// ---------- fundos desenhados (z → x do canvas, y → y do canvas)
function engrenagem(ctx, cx, cy, r, dentes, corpo, borda) {
  const passo = (Math.PI * 2) / dentes;
  ctx.beginPath();
  for (let i = 0; i < dentes; i++) {
    const a = i * passo;
    for (const [da, rr] of [[0, r], [passo * 0.18, r * 1.09], [passo * 0.5, r * 1.09], [passo * 0.68, r]]) {
      ctx.lineTo(cx + Math.cos(a + da) * rr, cy + Math.sin(a + da) * rr);
    }
  }
  ctx.closePath();
  ctx.fillStyle = corpo;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = borda;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = "#3a4048";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.09, 0, Math.PI * 2);
  ctx.fillStyle = "#9aa0a6";
  ctx.fill();
}

function circulo(ctx, cx, cy, r, preenchimento, borda = null, espessura = 2) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  if (preenchimento) {
    ctx.fillStyle = preenchimento;
    ctx.fill();
  }
  if (borda) {
    ctx.strokeStyle = borda;
    ctx.lineWidth = espessura;
    ctx.stroke();
  }
}

/** Placa de 4 castanhas guardada no fundo da caixa (como na foto da máquina). */
function placaGuardada(ctx, cx, cy, r) {
  circulo(ctx, cx, cy, r, "#8f969d", "#5d646b", 3);
  circulo(ctx, cx, cy, r * 0.82, null, "rgba(0,0,0,0.25)", 2);
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4 + (i * Math.PI) / 2);
    ctx.fillStyle = "#3a4048";
    ctx.fillRect(r * 0.2, -r * 0.07, r * 0.76, r * 0.14);
    ctx.fillStyle = "#b4bac1";
    ctx.fillRect(r * 0.42, -r * 0.11, r * 0.26, r * 0.22);
    ctx.strokeStyle = "#4a525c";
    ctx.lineWidth = 2;
    ctx.strokeRect(r * 0.42, -r * 0.11, r * 0.26, r * 0.22);
    ctx.restore();
  }
  circulo(ctx, cx, cy, r * 0.18, "#2b2f35");
}

function desenharEngrenagens(ctx, w, h, pz, py) {
  const r = (metros) => (metros * w) / 0.58; // metros → px
  // carcaça azul-escura, mais escura nas bordas (profundidade)
  const fundo = ctx.createLinearGradient(0, 0, w, h);
  fundo.addColorStop(0, "#28395a");
  fundo.addColorStop(1, "#17233a");
  ctx.fillStyle = fundo;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 18;
  ctx.strokeRect(0, 0, w, h);

  placaGuardada(ctx, pz(-0.075), py(0.84), r(0.125));

  // lira: braço que sustenta o trem de engrenagens
  ctx.strokeStyle = "#b9bec4";
  ctx.lineWidth = r(0.022);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(pz(-0.01), py(1.12));
  ctx.lineTo(pz(0.07), py(0.95));
  ctx.lineTo(pz(0.17), py(0.87));
  ctx.stroke();

  // trem de engrenagens (à direita)
  engrenagem(ctx, pz(0.125), py(1.085), r(0.03), 14, "#a3abb3", "#6b737c");
  engrenagem(ctx, pz(0.185), py(1.09), r(0.042), 20, "#9ea6af", "#6b737c");
  engrenagem(ctx, pz(0.245), py(1.06), r(0.024), 12, "#b0b7bf", "#6b737c");
  engrenagem(ctx, pz(0.15), py(0.975), r(0.05), 24, "#a3abb3", "#6b737c");
  engrenagem(ctx, pz(0.205), py(0.885), r(0.052), 26, "#9ea6af", "#6b737c");

  // ponta do eixo-árvore (em cima, ao centro): mancal, tampa e alavanca
  circulo(ctx, pz(0), py(1.17), r(0.05), "#5d6670", "#3a4048", 3);
  circulo(ctx, pz(0), py(1.17), r(0.032), "#c9ced4", "#7c848d", 2);
  circulo(ctx, pz(0), py(1.17), r(0.011), "#7c848d");
  ctx.strokeStyle = "#c9ced4";
  ctx.lineWidth = r(0.008);
  ctx.beginPath();
  ctx.moveTo(pz(0.03), py(1.18));
  ctx.lineTo(pz(0.11), py(1.2));
  ctx.stroke();
  ctx.fillStyle = "#c9ced4";
  ctx.fillRect(pz(0.105), py(1.215), r(0.02), r(0.03));

  // polia laranja (em cima, à esquerda)
  circulo(ctx, pz(-0.15), py(1.14), r(0.066), "#e2702a", "#8a3f12", 3);
  circulo(ctx, pz(-0.15), py(1.14), r(0.05), null, "#9a4615", r(0.008));
  circulo(ctx, pz(-0.15), py(1.14), r(0.022), "#c9ced4", "#7c848d", 2);
  circulo(ctx, pz(-0.15), py(1.14), r(0.008), "#3a4048");

  // reservatório de óleo com visor (embaixo, à direita)
  const x0 = pz(0.15);
  const x1 = pz(0.275);
  ctx.fillStyle = "#e9ecef";
  ctx.fillRect(x0, py(0.795), x1 - x0, py(0.715) - py(0.795));
  ctx.fillStyle = "rgba(210,140,20,0.75)";
  ctx.fillRect(x0 + 4, py(0.765), x1 - x0 - 8, py(0.72) - py(0.765));

  // cabo azul do sensor de rotação descendo pela lateral
  ctx.strokeStyle = "#2b7bd6";
  ctx.lineWidth = r(0.008);
  ctx.beginPath();
  ctx.moveTo(pz(-0.2), py(0.93));
  ctx.bezierCurveTo(pz(-0.27), py(0.82), pz(-0.27), py(0.74), pz(-0.12), py(0.73));
  ctx.lineTo(pz(0.14), py(0.74));
  ctx.stroke();
}

/** Folha de manutenção no lado de dentro da tampa (como na foto). */
function desenharDocumento(ctx, w, h) {
  ctx.fillStyle = "#4a525c";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#efe6c8";
  ctx.fillRect(12, 12, w - 24, h - 24);
  ctx.fillStyle = "#3a4048";
  ctx.font = "700 17px Segoe UI, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("PLANO DE MANUTENÇÃO", w / 2, 40);
  ctx.strokeStyle = "rgba(58,64,72,0.7)";
  ctx.lineWidth = 1.5;
  for (let y = 58; y < h - 24; y += 18) {
    ctx.beginPath();
    ctx.moveTo(24, y);
    ctx.lineTo(w - 24, y);
    ctx.stroke();
  }
  for (const x of [24, 110, 170, w - 24]) {
    ctx.beginPath();
    ctx.moveTo(x, 58);
    ctx.lineTo(x, h - 30);
    ctx.stroke();
  }
}

function desenharPainelEletrico(ctx, w, h, pz, py) {
  ctx.fillStyle = "#d8d3c6"; // placa de montagem
  ctx.fillRect(0, 0, w, h);
  // canaletas
  ctx.fillStyle = "#9aa1a8";
  ctx.fillRect(10, 10, w - 20, 26);
  ctx.fillRect(10, h - 40, w - 20, 26);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  for (let x = 18; x < w - 20; x += 14) {
    ctx.fillRect(x, 10, 5, 8);
    ctx.fillRect(x, h - 22, 5, 8);
  }
  // trilho DIN com disjuntores
  ctx.fillStyle = "#8d949b";
  ctx.fillRect(14, 56, w * 0.62, 10);
  for (let i = 0; i < 6; i++) {
    const x = 24 + i * 40;
    ctx.fillStyle = "#f4f4f2";
    ctx.fillRect(x, 44, 34, 66);
    ctx.fillStyle = "#2b2f35";
    ctx.fillRect(x + 12, 58, 10, 16);
    ctx.fillStyle = i < 3 ? "#1c7ed6" : "#d71920";
    ctx.fillRect(x + 4, 96, 26, 6);
  }
  // contator e relé de sobrecarga
  ctx.fillStyle = "#5c636b";
  ctx.fillRect(28, 128, 96, 90);
  ctx.fillStyle = "#3a4048";
  ctx.fillRect(28, 218, 96, 34);
  ctx.fillStyle = "#e9eef3";
  ctx.font = "700 22px Segoe UI, Arial, sans-serif";
  ctx.fillText("K1", 60, 178);
  // fiação até a borneira e ao cabo do motor
  ctx.lineWidth = 4;
  for (const [i, cor] of ["#1a1d21", "#1a1d21", "#1a1d21", "#1c7ed6"].entries()) {
    ctx.strokeStyle = cor;
    ctx.beginPath();
    ctx.moveTo(44 + i * 20, 252);
    ctx.lineTo(44 + i * 20, 268);
    ctx.lineTo(pz(0.12) - 6 + i * 4, 268);
    ctx.lineTo(pz(0.12) - 6 + i * 4, h - 40);
    ctx.stroke();
  }
  // borneira
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = i % 5 === 4 ? "#1c7ed6" : "#9aa1a8";
    ctx.fillRect(160 + i * 16, 150, 13, 52);
  }
  ctx.fillStyle = "#8d949b";
  ctx.fillRect(152, 170, 240, 8);
}
