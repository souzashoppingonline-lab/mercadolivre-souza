# -*- coding: utf-8 -*-
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                HRFlowable, ListFlowable, ListItem, PageBreak)

OUT = "/home/user/mercadolivre-souza/print-agent/MANUAL-Agente-Impressao.pdf"

AZUL = colors.HexColor("#1f4e79")
AZUL2 = colors.HexColor("#2e6da4")
CINZA = colors.HexColor("#444444")
VERDE = colors.HexColor("#1e7e34")
AMARELO = colors.HexColor("#fff3cd")
AMARELO_B = colors.HexColor("#e0a800")
VERM_BG = colors.HexColor("#f8d7da")
VERM_B = colors.HexColor("#c0392b")
AZUL_BG = colors.HexColor("#e8f0fe")

styles = getSampleStyleSheet()
H1 = ParagraphStyle('H1', parent=styles['Heading1'], fontSize=16, textColor=colors.white,
                    spaceAfter=8, spaceBefore=4, leading=20)
H2 = ParagraphStyle('H2', parent=styles['Heading2'], fontSize=12.5, textColor=AZUL,
                    spaceAfter=4, spaceBefore=10, leading=15)
BODY = ParagraphStyle('Body', parent=styles['Normal'], fontSize=10.5, leading=15, textColor=CINZA)
STEP = ParagraphStyle('Step', parent=BODY, leftIndent=4)
MONO = ParagraphStyle('Mono', parent=styles['Code'], fontSize=9, textColor=colors.black,
                      backColor=colors.HexColor("#f0f0f0"), leading=12, leftIndent=6, rightIndent=6,
                      spaceBefore=3, spaceAfter=3, borderPadding=(4,4,4,4))
TITLE = ParagraphStyle('Title', parent=styles['Title'], fontSize=22, textColor=AZUL, leading=26)
SUB = ParagraphStyle('Sub', parent=styles['Normal'], fontSize=11, textColor=CINZA, alignment=TA_CENTER)

def sec_header(txt):
    t = Table([[Paragraph(txt, H1)]], colWidths=[170*mm])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),AZUL2),
                           ('LEFTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),4),
                           ('BOTTOMPADDING',(0,0),(-1,-1),4)]))
    return t

def box(txt, bg, border, titulo=None):
    inner = []
    if titulo:
        inner.append(Paragraph(f"<b>{titulo}</b>", ParagraphStyle('bt', parent=BODY, textColor=border)))
    inner.append(Paragraph(txt, BODY))
    t = Table([[inner]], colWidths=[170*mm])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),bg),('BOX',(0,0),(-1,-1),1,border),
                           ('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),
                           ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)]))
    return t

def steps(items):
    return ListFlowable([ListItem(Paragraph(i, STEP), leftIndent=14, value=n+1)
                         for n,i in enumerate(items)], bulletType='1', leftIndent=8)

S = []
# ── Capa ──
S.append(Spacer(1, 30*mm))
S.append(Paragraph("Manual do Agente de Impressão de Etiquetas", TITLE))
S.append(Spacer(1, 4*mm))
S.append(Paragraph("Como usar no dia a dia • Trocar de computador • Adicionar a 2ª impressora", SUB))
S.append(Spacer(1, 6*mm))
S.append(HRFlowable(width="60%", thickness=1.2, color=AZUL, spaceBefore=2, spaceAfter=2, hAlign='CENTER'))
S.append(Spacer(1, 8*mm))
S.append(box("Este manual é para os funcionários da <b>expedição</b>. Não precisa saber "
             "programação — é só seguir os passos com atenção. Guarde este documento perto "
             "do computador da impressão.", AZUL_BG, AZUL2, "Para quem é este manual"))
S.append(Spacer(1, 60*mm))
S.append(Paragraph("Sistema: ML Dashboard Multimarcas &nbsp;•&nbsp; Impressão automática de etiquetas 10×15", SUB))
S.append(PageBreak())

# ── 1. O que é ──
S.append(sec_header("1. O que é isso (resumo)"))
S.append(Spacer(1,4))
S.append(Paragraph("Quando o funcionário <b>bipa a etiqueta 2 vezes</b> na tela de Embalagem "
    "(1º bipe mostra o pedido e grava o vídeo; 2º bipe encerra), a etiqueta 10×15 com o aviso "
    "<b>FRÁGIL</b> sai <b>sozinha</b> na impressora térmica, sem clicar em nada.", BODY))
S.append(Paragraph("Quem faz isso acontecer é o <b>Agente</b>: um programinha que fica rodando "
    "no computador da expedição. Ele conversa com o servidor, pega a etiqueta e manda pra "
    "impressora. <b>Enquanto o agente estiver rodando, tudo funciona sozinho.</b>", BODY))
S.append(Spacer(1,4))
S.append(box("O agente aparece como uma <b>janela preta</b> escrita “Agente de Impressao de "
    "Etiquetas”. <b>Nunca feche essa janela durante o expediente</b> — se fechar, para de imprimir.",
    AMARELO, AMARELO_B, "⚠ Importante"))

# ── 2. Dia a dia ──
S.append(sec_header("2. Ligar e desligar o computador (dia a dia)"))
S.append(Spacer(1,4))
S.append(Paragraph("<b>Ao LIGAR o computador de manhã:</b>", H2))
S.append(Paragraph("Se o início automático estiver configurado (ver Seção 3), o agente <b>sobe "
    "sozinho</b> — não precisa fazer nada. Confira se a janela preta “Agente de Impressao” está "
    "aberta.", BODY))
S.append(Paragraph("Se a janela <b>não</b> estiver aberta, inicie manualmente:", BODY))
S.append(steps([
    "Abra a pasta <b>C:\\print-agent</b> (Explorador de Arquivos → Disco C: → print-agent).",
    "Dê <b>dois cliques</b> no arquivo <b>iniciar-agente</b> (ícone de engrenagem/janela preta).",
    "Vai abrir a janela preta. Deixe-a aberta e minimizada. Pronto — já está imprimindo.",
]))
S.append(Spacer(1,3))
S.append(Paragraph("<b>Ao DESLIGAR o computador (fim do dia):</b>", H2))
S.append(Paragraph("Pode desligar normalmente pelo Windows. Não precisa fechar nada à mão — "
    "os pedidos que ficarem sem imprimir <b>não se perdem</b>: assim que o computador voltar e o "
    "agente iniciar, eles imprimem.", BODY))
S.append(Spacer(1,3))
S.append(box("Se alguém <b>fechar sem querer</b> a janela preta no meio do dia: é só repetir os "
    "passos acima (dois cliques no <b>iniciar-agente</b>). Nada se perde.", AZUL_BG, AZUL2, "Fechou sem querer?"))

# ── 3. Autostart ──
S.append(sec_header("3. Fazer o agente iniciar SOZINHO com o Windows"))
S.append(Spacer(1,4))
S.append(Paragraph("Faça isso <b>uma vez só</b>. Depois, toda vez que o computador ligar, o "
    "agente sobe automaticamente e ninguém precisa lembrar de abrir.", BODY))
S.append(steps([
    "Aperte as teclas <b>Windows + R</b> ao mesmo tempo (abre uma janelinha “Executar”).",
    "Digite <b>shell:startup</b> e aperte Enter. Vai abrir a pasta “Inicializar”.",
    "Em outra janela, abra <b>C:\\print-agent</b>.",
    "Clique com o <b>botão direito</b> no arquivo <b>iniciar-agente</b> → <b>Copiar</b>.",
    "Volte na pasta “Inicializar”, clique com o botão direito num espaço vazio → "
    "<b>Colar atalho</b> (não “Colar” normal — “Colar atalho”).",
]))
S.append(box("Pronto. Para testar: reinicie o computador. Depois de ligar, a janela preta do "
    "agente deve aparecer sozinha em alguns segundos.", AZUL_BG, VERDE, "✓ Testar"))
S.append(PageBreak())

# ── 4. Trocar de computador ──
S.append(sec_header("4. Trocar de computador (PC novo)"))
S.append(Spacer(1,4))
S.append(Paragraph("Quando o computador da expedição for trocado, faça no <b>PC novo</b>:", BODY))
S.append(steps([
    "Instalar o <b>Node.js</b>: abra o site <b>nodejs.org</b>, baixe a versão <b>LTS</b> "
    "(botão verde) e instale clicando em Next → Next → Install → Finish.",
    "Instalar o <b>SumatraPDF</b>: site <b>sumatrapdfreader.org</b>, baixe o instalador "
    "<b>64-bit</b> e instale.",
    "Copiar a pasta <b>C:\\print-agent</b> inteira do computador antigo (por pen drive) "
    "para o <b>Disco C:</b> do computador novo, no mesmo lugar (fica <b>C:\\print-agent</b>). "
    "Essa pasta já tem toda a configuração — <b>não precisa mexer em nada dentro dela.</b>",
    "Conferir o nome da impressora no PC novo: se for a <b>mesma</b> impressora, tudo certo. "
    "Se for <b>outra</b> impressora, veja a Seção 6 (“nome da impressora”) para ajustar.",
    "Dar dois cliques em <b>iniciar-agente</b> (dentro de C:\\print-agent) para testar. "
    "Bipe uma etiqueta 2× e veja se imprime.",
    "Configurar o início automático no PC novo (Seção 3).",
]))
S.append(box("A pasta <b>C:\\print-agent</b> carrega o “crachá” (token) da estação dentro do "
    "arquivo <b>config.json</b>. Por isso, copiando a pasta inteira, o PC novo já assume o lugar "
    "do antigo sem precisar de senha nova.", AZUL_BG, AZUL2, "Por que copiar a pasta inteira"))

# ── 5. Segunda impressora ──
S.append(sec_header("5. Adicionar a 2ª impressora (2ª estação de embalagem)"))
S.append(Spacer(1,4))
S.append(Paragraph("Quando montarem a <b>segunda estação de embalagem</b> (2º computador + 2ª "
    "impressora), são duas partes:", BODY))
S.append(Paragraph("<b>Parte A — no servidor</b> (quem tem acesso ao servidor / administrador):", H2))
S.append(Paragraph("Criar a 2ª estação e pegar o novo “crachá” (token). No servidor, dentro da "
    "pasta do sistema, rodar:", BODY))
S.append(Paragraph("cd /opt/ml-dashboard-novo/server", MONO))
S.append(Paragraph("node -e \"const p=require('./src/db/pool');const c=require('crypto');"
    "(async()=>{const t=c.randomBytes(24).toString('hex');const{rows}=await p.query("
    "\\\"INSERT INTO print_stations (name,store_id,token,printer_name) VALUES "
    "('Expedicao 2',NULL,\\$1,'NOME_DA_2A_IMPRESSORA') RETURNING id,token\\\",[t]);"
    "console.log(rows[0]);await p.end();process.exit(0)})()\"", MONO))
S.append(Paragraph("Anote o <b>token</b> que aparecer (é o crachá da 2ª estação).", BODY))
S.append(Paragraph("<b>Parte B — no 2º computador:</b>", H2))
S.append(steps([
    "Instalar Node.js e SumatraPDF (igual à Seção 4, passos 1 e 2).",
    "Copiar a pasta <b>C:\\print-agent</b> de um PC que já funciona.",
    "Abrir o arquivo <b>config.json</b> (dentro de C:\\print-agent) com o Bloco de Notas e "
    "trocar duas coisas: o <b>stationToken</b> pelo token novo (Parte A) e o "
    "<b>printerName</b> pelo nome exato da 2ª impressora. Salvar.",
    "Dar dois cliques em <b>iniciar-agente</b> e configurar o início automático (Seção 3).",
]))
S.append(Paragraph("<b>No painel (dashboard), em cada computador:</b>", H2))
S.append(Paragraph("Quando houver 2 estações, aparece na tela de Embalagem um seletor "
    "<b>“Imprimir nesta estação”</b>. Em cada PC, escolha a estação correspondente (a impressora "
    "daquele PC). Isso faz cada computador imprimir na sua própria impressora.", BODY))
S.append(PageBreak())

# ── 6. Problemas ──
S.append(sec_header("6. Problemas comuns e soluções"))
S.append(Spacer(1,6))
prob = [
    ["Problema", "O que fazer"],
    ["Não imprime nada",
     "1) A janela preta do agente está aberta? Se não, dê 2 cliques em iniciar-agente.\n"
     "2) A impressora está ligada, com papel e sem luz de erro?\n"
     "3) Teste bipar 2× de novo."],
    ["Etiqueta sai encolhida / cortada",
     "O tamanho de papel padrão da impressora não está em 10×15 cm. Ajuste nas "
     "propriedades da impressora (Dispositivos e Impressoras → clique direito → "
     "Preferências → tamanho do papel 10×15)."],
    ["Aparece “HTTP 401” na janela preta",
     "O crachá (token) no config.json está errado. Confirme que copiou o token certo."],
    ["Aparece “SumatraPDF” / erro ao imprimir",
     "O SumatraPDF não está instalado ou o nome da impressora no config.json está "
     "diferente do nome real no Windows (veja abaixo)."],
    ["Nome da impressora",
     "Para ver o nome exato: abra o PowerShell e digite  Get-Printer | Format-Table Name . "
     "Copie o nome idêntico para o campo printerName do config.json."],
]
t = Table([[Paragraph(c, BODY if i else ParagraphStyle('th',parent=BODY,textColor=colors.white,fontName='Helvetica-Bold')) for c in row]
           for i,row in enumerate(prob)], colWidths=[55*mm, 115*mm])
t.setStyle(TableStyle([
    ('BACKGROUND',(0,0),(-1,0),AZUL2),
    ('GRID',(0,0),(-1,-1),0.5,colors.HexColor("#cccccc")),
    ('VALIGN',(0,0),(-1,-1),'TOP'),
    ('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),
    ('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5),
    ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, colors.HexColor("#f6f8fb")]),
]))
S.append(t)

# ── 7. Dados desta instalação ──
S.append(sec_header("7. Dados desta instalação (preencha e guarde)"))
S.append(Spacer(1,6))
dados = [
    ["Endereço do sistema", "https://multimixvendas.duckdns.org"],
    ["Pasta do agente no PC", "C:\\print-agent"],
    ["Arquivo que inicia o agente", "iniciar-agente (dentro da pasta acima)"],
    ["Arquivo de configuração", "config.json (tem o token e o nome da impressora)"],
    ["Impressora (Estação 1)", "ELGIN L42PRO FULL"],
    ["Token da Estação 1", "(está dentro do config.json — é uma senha, não divulgue)"],
    ["Impressora (Estação 2)", "________________________________"],
    ["Token da Estação 2", "________________________________"],
]
t2 = Table([[Paragraph(f"<b>{a}</b>", BODY), Paragraph(b, BODY)] for a,b in dados],
           colWidths=[55*mm, 115*mm])
t2.setStyle(TableStyle([
    ('GRID',(0,0),(-1,-1),0.5,colors.HexColor("#cccccc")),
    ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
    ('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),
    ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6),
    ('BACKGROUND',(0,0),(0,-1),colors.HexColor("#eef2f7")),
]))
S.append(t2)
S.append(Spacer(1,6))
S.append(box("Dúvida que este manual não resolve? Anote o que aparece na <b>janela preta</b> do "
    "agente (a mensagem de erro) e chame o suporte técnico.", AMARELO, AMARELO_B, "Precisa de ajuda?"))

def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(colors.grey)
    canvas.drawString(20*mm, 12*mm, "Manual do Agente de Impressão — ML Dashboard Multimarcas")
    canvas.drawRightString(190*mm, 12*mm, f"Página {doc.page}")
    canvas.restoreState()

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=20*mm, rightMargin=20*mm,
                        topMargin=16*mm, bottomMargin=18*mm, title="Manual do Agente de Impressão de Etiquetas")
doc.build(S, onFirstPage=footer, onLaterPages=footer)
print("PDF gerado:", OUT)
