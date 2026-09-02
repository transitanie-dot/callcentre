/**
 * airportlink-callcentre/server.js
 * ---------------------------------------------------------------
 * O painel de operações, servido da sua própria origem.
 *
 * Antes vivia dentro de um iframe do Wix, e isso custava três
 * coisas:
 *
 *  - Dois segundos de latência por chamada, porque cada pedido
 *    saltava de um domínio para outro.
 *  - O prompt() e o confirm() do browser bloqueados pelo sandbox,
 *    devolvendo "cancelar" em silêncio.
 *  - Um ficheiro de 271 KB que tinha de ser substituído por
 *    inteiro a cada correção de uma linha.
 *
 * Aqui o painel é servido da mesma origem que a API do apoio, e
 * está partido em três ficheiros que se atualizam à parte.
 *
 * Este serviço NÃO fala com a base de dados. É um servidor de
 * ficheiros com uma verificação de acesso — quem trata dos dados
 * continua a ser o serviço de drivers.
 * ---------------------------------------------------------------
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * As marcas que este call centre atende.
 *
 * Uma linha por marca, e o painel desenha uma aba para cada. O
 * `key` é o que vai na base de dados e nunca muda; o `label` é o
 * que os agentes leem e pode mudar quando quiseres.
 *
 * Vem de variável de ambiente para se poder acrescentar uma marca
 * sem publicar código novo.
 */
function marcas() {
  const bruto = process.env.BRANDS;

  if (!bruto) {
    // Só a Airportlink. É o estado de hoje, e serve de valor
    // seguro se a variável faltar.
    return [{ key: 'airportlink', label: 'Airportlink', color: '#0F766E' }];
  }

  try {
    const lista = JSON.parse(bruto);
    if (Array.isArray(lista) && lista.length) return lista;
  } catch (e) {
    console.error('BRANDS is not valid JSON, falling back to Airportlink only.');
  }

  return [{ key: 'airportlink', label: 'Airportlink', color: '#0F766E' }];
}

/**
 * A configuração que o painel precisa de saber antes de arrancar.
 *
 * Servida como JavaScript e não como JSON: assim entra com uma
 * etiqueta <script> normal, antes do desk.js, e não há um momento
 * em que o painel esteja desenhado mas sem saber que marcas existem.
 */
/**
 * A versão dos ficheiros do painel.
 *
 * O CSS e o JS levam cache de sete dias, e isso é bom — mas
 * significa que uma correção pode levar uma semana a chegar a quem
 * já tem o painel aberto.
 *
 * O index referencia-os com ?v=<versão>. Quando esta muda, o
 * endereço muda, e o browser é obrigado a ir buscar o novo. O
 * Render põe a RENDER_GIT_COMMIT sozinho a cada publicação, por
 * isso a versão muda a cada deploy sem se tocar em nada.
 */
const VERSAO = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 8);

app.get('/assets/config.js', (req, res) => {
  const cfg = {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    driversUrl: process.env.DRIVERS_URL || 'https://drivers.airportlink.app',
    mainApiUrl: process.env.MAIN_API_URL || 'https://airportlink.onrender.com',
    brands: marcas()
  };

  res.type('application/javascript');
  // Sem cache: as chaves e as marcas mudam sem o ficheiro mudar de
  // nome, e um painel a correr com configuração velha é o género
  // de avaria que ninguém encontra.
  res.set('Cache-Control', 'no-store');
  res.send('window.__DESK_CONFIG = ' + JSON.stringify(cfg) + ';');
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'callcentre',
    brands: marcas().map((b) => b.key),
    time: new Date().toISOString()
  });
});

/**
 * Os ficheiros do painel.
 *
 * O CSS e o JavaScript levam cache longa porque mudam de nome
 * quando mudam de conteúdo — o index.html referencia-os com uma
 * versão. O index em si nunca leva cache: é ele que aponta para as
 * versões novas, e um index em cache serve ficheiros velhos.
 */
app.use('/assets', express.static(path.join(ROOT, 'public/assets'), {
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.set('Cache-Control', 'public, max-age=604800');
    }
  }
}));

app.use(express.static(path.join(ROOT, 'public'), {
  index: false,
  setHeaders(res) {
    res.set('Cache-Control', 'no-store');
  }
}));

/**
 * Um ficheiro em falta tem de dar 404, não a página.
 *
 * Sem isto, um pedido a /assets/desk.js que não existe recebe o
 * index.html — e o browser tenta interpretar HTML como JavaScript,
 * dando "Unexpected token '<'". O erro não nomeia o ficheiro em
 * falta e perde-se meia hora a perceber que é só um ficheiro que
 * não foi publicado.
 */
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();

  if (/\.(js|css|map|png|jpg|jpeg|svg|webp|ico|json|txt|woff2?)$/.test(req.path)) {
    console.warn('Static file not found:', req.path);
    return res.status(404).type('text/plain').send('Not found: ' + req.path);
  }

  return next();
});

// Tudo o resto é o painel. Middleware em vez de app.get('*'): o
// Express 5 removeu o asterisco como padrão e rebenta no arranque
// com "Missing parameter name" — o serviço nem sobe, e do lado do
// browser vê-se 502, que não aponta para lado nenhum.
const INDEX = path.join(ROOT, 'public', 'index.html');

/**
 * O painel não está lá? Diz-se logo no arranque.
 *
 * Sem isto o serviço sobe, o /health responde, e a raiz devolve um
 * erro vazio — o que parece o painel a carregar para sempre. Foi
 * exatamente isso que aconteceu, e não havia nada nos registos que
 * apontasse para o ficheiro em falta.
 */
if (!fs.existsSync(INDEX)) {
  console.error(
    '\n  public/index.html is missing.\n' +
    '  Looked in: ' + INDEX + '\n' +
    '  The service will start, but the panel will not load.\n' +
    '  Check that the public/ folder was pushed, and that Root Directory\n' +
    '  on Render points at the folder containing server.js.\n'
  );
}

app.use((req, res) => {
  res.set('Cache-Control', 'no-store');

  // O index é lido e servido com a versão injetada, em vez de
  // enviado tal e qual: assim os endereços do CSS e do JS mudam a
  // cada publicação e ninguém fica com uma versão velha.
  fs.readFile(INDEX, 'utf8', (err, html) => {
    if (!err) {
      /**
       * Confirma que é mesmo o painel.
       *
       * Se o public/index.html for substituído por outra coisa — um
       * ficheiro trocado numa publicação, por exemplo — o servidor
       * mandava-o na mesma, e o browser mostrava JavaScript como
       * texto sem nada explicar porquê.
       */
      if (html.indexOf('<!DOCTYPE') !== 0 && html.indexOf('<html') < 0) {
        console.error('public/index.html does not look like HTML. First 80 chars:',
          JSON.stringify(html.slice(0, 80)));

        return res.status(500).type('text/plain').send(
          'public/index.html is not an HTML file.\n\n' +
          'It starts with: ' + html.slice(0, 60) + '\n\n' +
          'Something was overwritten during deployment.'
        );
      }

      return res.type('html').send(
        html.replace(/\/assets\/(desk\.css|desk\.js)/g, '/assets/$1?v=' + VERSAO)
      );
    }

    // Um sendFile que falha não escreve nada em lado nenhum: a
    // resposta fica pendurada e o browser espera até desistir.
    console.error('Could not send index.html:', err.message);

    res.status(500).type('text/plain').send(
      'The panel files are not on the server.\n\n' +
      'Expected: public/index.html\n' +
      'Looked in: ' + INDEX + '\n\n' +
      'This is a deployment problem, not a code one.'
    );
  });
});

app.listen(PORT, () => {
  console.log(`Call centre running on ${PORT}`);
  console.log('Brands:', marcas().map((b) => b.label).join(', '));
});
