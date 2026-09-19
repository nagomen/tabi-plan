const BACCARAT_DETAIL_HTML = `
  <details class="cg-game-more">
    <summary>
      <span class="cg-game-more-label">BACCARAT · BEGINNER</span>
      <span class="cg-game-more-copy">
        <b class="cg-game-more-open">もっと見る</b>
        <b class="cg-game-more-close">詳細を閉じる</b>
        <small>点数計算から1ゲームの流れまで、約3分で理解</small>
      </span>
      <span class="cg-game-more-mark" aria-hidden="true">＋</span>
    </summary>

    <div class="cg-game-detail">
      <div class="cg-game-detail-intro">
        <p>FIRST THING TO KNOW</p>
        <h4>PlayerとBankerは「人」ではなく、<br>2つの手札の名前</h4>
        <span>自分がPlayer役になるゲームではありません。カードはディーラーが配り、参加者は結果がPlayer側・Banker側・Tieのどれになるかを予想します。</span>
      </div>

      <section class="cg-baccarat-lesson" aria-labelledby="baccaratScoreTitle">
        <div class="cg-game-detail-heading"><span>01</span><div><p>COUNT THE LAST DIGIT</p><h5 id="baccaratScoreTitle">点数は合計の「1の位」だけ</h5></div></div>
        <p class="cg-game-detail-lead">Aは1点、2〜9は数字どおり、10・J・Q・Kは0点です。合計が10以上なら十の位を捨てます。最終的に9へ近い側が勝ちです。</p>
        <div class="cg-baccarat-score" aria-label="バカラの点数計算例">
          <div><span>7 ＋ 8</span><small>合計15</small><b>5点</b></div>
          <div><span>K ＋ 9</span><small>0 ＋ 9</small><b>9点</b></div>
          <div><span>A ＋ 9</span><small>合計10</small><b>0点</b></div>
        </div>
        <p class="cg-game-detail-note"><b>覚え方</b> カードの合計を普通に足して、最後の数字だけを見る。スート（♠♥♦♣）は勝敗に関係しません。</p>
      </section>

      <section class="cg-baccarat-lesson" aria-labelledby="baccaratFlowTitle">
        <div class="cg-game-detail-heading"><span>02</span><div><p>ONE ROUND, STEP BY STEP</p><h5 id="baccaratFlowTitle">1ゲームはこの5段階</h5></div></div>
        <ol class="cg-baccarat-flow">
          <li><b>受付中を確認</b><span>卓のMin/Maxと配当を確認し、ベット受付中にだけチップを置きます。</span></li>
          <li><b>賭け先を選ぶ</b><span>初心者はPlayerかBankerの本線だけ。1ゲームの上限額を超えないようにします。</span></li>
          <li><b>最初の2枚</b><span>Player側とBanker側へ2枚ずつ配られます。最初から8か9ならNaturalとなり、通常はそこで勝負が決まります。</span></li>
          <li><b>第3カード</b><span>必要な場合だけ追加されます。引く・止めるは決められたルールで自動進行するため、参加者が判断する必要はありません。</span></li>
          <li><b>比較・精算</b><span>最終点を比べ、9に近い側が勝ち。同点ならTieです。精算が終わるまでチップには触れません。</span></li>
        </ol>
      </section>

      <section class="cg-baccarat-lesson" aria-labelledby="baccaratBetTitle">
        <div class="cg-game-detail-heading"><span>03</span><div><p>CHOOSE THE MAIN LINE</p><h5 id="baccaratBetTitle">賭け先はまず2つだけ理解</h5></div></div>
        <div class="cg-baccarat-bets">
          <div class="is-beginner"><b>PLAYER</b><strong>Player側が勝つ</strong><span>一般的には等倍。本線として分かりやすい選択です。</span></div>
          <div class="is-beginner"><b>BANKER</b><strong>Banker側が勝つ</strong><span>一般的なコミッション方式では勝利配当から手数料が差し引かれます。ノーコミッション卓など別方式もあるため表示を確認します。</span></div>
          <div><b>TIE</b><strong>両側が同点</strong><span>高配当でも当たりにくい賭け。Player / Bankerへの賭けは通常返却されますが、卓上ルールを優先します。</span></div>
          <div><b>PAIR / SIDE BET</b><strong>特定の組合せ</strong><span>高配当の追加ベット。条件と確率を理解するまでは使いません。</span></div>
        </div>
      </section>

      <section class="cg-baccarat-lesson" aria-labelledby="baccaratExampleTitle">
        <div class="cg-game-detail-heading"><span>04</span><div><p>READ A SAMPLE ROUND</p><h5 id="baccaratExampleTitle">表示中の例を読んでみる</h5></div></div>
        <div class="cg-baccarat-example">
          <div><span>PLAYER</span><b>4 ＋ 3</b><strong>7点</strong></div>
          <em aria-hidden="true">VS</em>
          <div class="is-winner"><span>BANKER</span><b>6 ＋ 2</b><strong>8点</strong></div>
          <p>Bankerの8点がPlayerの7点より9に近いため、<b>Bankerの勝ち</b>です。どちらも最初の2枚で決着し、参加者がカードを引く判断はありません。</p>
        </div>
      </section>

      <section class="cg-baccarat-lesson is-last" aria-labelledby="baccaratFirstTableTitle">
        <div class="cg-game-detail-heading"><span>05</span><div><p>YOUR FIRST TABLE</p><h5 id="baccaratFirstTableTitle">初回はこの順番なら迷わない</h5></div></div>
        <ul class="cg-baccarat-check">
          <li><b>1</b><span>後ろから2〜3ゲーム見て、ベット開始と締切の合図を確認</span></li>
          <li><b>2</b><span>Min、Bankerの配当方式、チップの置き場所を確認</span></li>
          <li><b>3</b><span>Player / Bankerのどちらかに、決めた1ゲーム分だけ置く</span></li>
          <li><b>4</b><span>配札中は触らず、精算が終わってから次を判断</span></li>
          <li><b>5</b><span>連勝・連敗の表示を予測根拠にせず、金額と終了時刻を守る</span></li>
        </ul>
        <aside class="cg-baccarat-takeaway"><b>これだけ覚えれば参加できます</b><span>「合計の1の位を比べる」「カード追加は自動」「最初はPlayer / Bankerだけ」「精算中はチップに触らない」。卓ごとの配当・手数料・最低額は必ず現地表示を優先してください。</span></aside>
      </section>
    </div>
  </details>`;

const BLACKJACK_DETAIL_HTML = `
  <details class="cg-game-more">
    <summary>
      <span class="cg-game-more-label">BLACKJACK · HOUSE EDGE</span>
      <span class="cg-game-more-copy">
        <b class="cg-game-more-open">もっと見る</b>
        <b class="cg-game-more-close">詳細を閉じる</b>
        <small>期待値、ハウスエッジ、基本戦略の読み方を理解</small>
      </span>
      <span class="cg-game-more-mark" aria-hidden="true">＋</span>
    </summary>

    <div class="cg-game-detail">
      <div class="cg-game-detail-intro">
        <p>FIRST THING TO KNOW</p>
        <h4>「勝ちやすさ」は、着席する前の<br>ルール確認で大きく変わる</h4>
        <span>ブラックジャックは判断で差が出るゲームですが、基本戦略を使っても長期的な期待値は通常マイナスです。まず配当と卓ルールを確認し、その条件専用の基本戦略を使います。</span>
      </div>

      <section class="cg-baccarat-lesson" aria-labelledby="blackjackEdgeTitle">
        <div class="cg-game-detail-heading"><span>01</span><div><p>WHAT HOUSE EDGE MEANS</p><h5 id="blackjackEdgeTitle">ハウスエッジは「1回の負ける確率」ではない</h5></div></div>
        <p class="cg-game-detail-lead">ハウスエッジは、長期間に賭けた総額に対してカジノ側へ残ると見込まれる平均割合です。0.5%なら、HK$10,000を何度も賭けた長期平均の期待損失はHK$50。今夜必ずHK$50負けるという意味ではありません。</p>
        <div class="cg-blackjack-formula" aria-label="期待損失の計算式">
          <div><span>平均ベット</span><b>HK$200</b></div><i>×</i>
          <div><span>ゲーム数</span><b>50回</b></div><i>×</i>
          <div><span>ハウスエッジ</span><b>0.5%</b></div><em>＝</em>
          <div class="is-result"><span>期待損失</span><b>HK$50</b></div>
        </div>
        <p class="cg-game-detail-note"><b>重要</b> SplitやDoubleで追加した賭けも総賭け額に含まれます。手元資金ではなく、繰り返し賭けた「総アクション額」で考えます。</p>
      </section>

      <section class="cg-baccarat-lesson" aria-labelledby="blackjackRulesTitle">
        <div class="cg-game-detail-heading"><span>02</span><div><p>READ THE TABLE RULES</p><h5 id="blackjackRulesTitle">期待値を左右する5つの表示</h5></div></div>
        <div class="cg-blackjack-rule-table" role="table" aria-label="ブラックジャックのルール差とプレイヤー期待値への影響">
          <div class="cg-blackjack-rule-head" role="row"><span role="columnheader">確認項目</span><span role="columnheader">選びたい条件</span><span role="columnheader">不利な条件の目安</span><span role="columnheader">意味</span></div>
          <div role="row"><b role="cell">BJ配当</b><strong role="cell">3 : 2</strong><span role="cell" class="is-danger">6 : 5で約−1.39pt</span><small role="cell">最優先。HK$100のBlackjackが3:2なら利益HK$150、6:5ならHK$120。</small></div>
          <div role="row"><b role="cell">Soft 17</b><strong role="cell">S17 · Stand</strong><span role="cell">H17で約−0.22pt</span><small role="cell">A+6をディーラーが止まるか、もう1枚引くか。S17の方がプレイヤーに有利。</small></div>
          <div role="row"><b role="cell">Split後Double</b><strong role="cell">DAS可</strong><span role="cell">不可で約−0.14pt</span><small role="cell">分けた手でDoubleできるか。DAS = Double After Split。</small></div>
          <div role="row"><b role="cell">Double範囲</b><strong role="cell">最初の任意2枚</strong><span role="cell">10・11のみで約−0.18pt</span><small role="cell">有利な場面で賭けを増やせる範囲。卓によって9〜11、10・11のみなどがあります。</small></div>
          <div role="row"><b role="cell">Surrender</b><strong role="cell">Late Surrender可</strong><span role="cell">利用価値 約＋0.08pt</span><small role="cell">不利な初手を半額返却で降りる選択。利用できる相手札とタイミングを確認。</small></div>
        </div>
        <p class="cg-game-detail-note"><b>pt</b> パーセントポイント。各数値は標準的な比較条件に対する概算で、単純合算がその卓の正確なハウスエッジになるとは限りません。</p>
      </section>

      <section class="cg-baccarat-lesson" aria-labelledby="blackjackExpectedTitle">
        <div class="cg-game-detail-heading"><span>03</span><div><p>EXPECTED LOSS TABLE</p><h5 id="blackjackExpectedTitle">総賭け額ごとの期待損失</h5></div></div>
        <p class="cg-game-detail-lead">正しい基本戦略を使った場合の長期平均です。実際の1セッションは分散が大きく、この表より大幅に勝つことも負けることもあります。</p>
        <div class="cg-blackjack-ev-wrap">
          <table class="cg-blackjack-ev">
            <caption>期待損失 ＝ 総賭け額 × ハウスエッジ</caption>
            <thead><tr><th>総賭け額</th><th>0.3%<small>良条件の目安</small></th><th>0.5%<small>良好</small></th><th>1.0%<small>条件・ミスあり</small></th><th>2.0%<small>6:5等に注意</small></th></tr></thead>
            <tbody>
              <tr><th>HK$5,000</th><td>HK$15</td><td>HK$25</td><td>HK$50</td><td>HK$100</td></tr>
              <tr><th>HK$10,000</th><td>HK$30</td><td>HK$50</td><td>HK$100</td><td>HK$200</td></tr>
              <tr><th>HK$30,000</th><td>HK$90</td><td>HK$150</td><td>HK$300</td><td>HK$600</td></tr>
              <tr><th>HK$50,000</th><td>HK$150</td><td>HK$250</td><td>HK$500</td><td>HK$1,000</td></tr>
            </tbody>
          </table>
        </div>
        <aside class="cg-blackjack-warning"><b>0.5%は「所持金の0.5%」ではない</b><span>HK$2,000を持ってHK$200を50回賭ければ総賭け額はHK$10,000です。同じチップを何度も使うほど総アクション額は増え、期待損失も増えます。</span></aside>
      </section>

      <section class="cg-baccarat-lesson" aria-labelledby="blackjackStrategyTitle">
        <div class="cg-game-detail-heading"><span>04</span><div><p>BASIC STRATEGY, NOT A HUNCH</p><h5 id="blackjackStrategyTitle">基本戦略表は「自分の手 × 相手の表札」で読む</h5></div></div>
        <p class="cg-game-detail-lead">基本戦略は次の1手の期待損失を最小にする表です。勝利を保証する表ではなく、ルールごとに内容が変わります。以下は6デック以上・S17・DASを想定した代表例です。</p>
        <div class="cg-blackjack-strategy">
          <div class="cg-blackjack-strategy-head"><span>自分の手</span><span>Dealer 2〜6</span><span>Dealer 7〜A</span><span>理由</span></div>
          <div><b>Hard 8以下</b><strong>Hit</strong><strong>Hit</strong><span>止まるには弱すぎる</span></div>
          <div><b>Hard 12</b><strong>4〜6はStand<br>2・3はHit</strong><strong>Hit</strong><span>DealerのBustしやすさで切替</span></div>
          <div><b>Hard 13〜16</b><strong>Stand</strong><strong>Hit</strong><span>弱い表札にはDealerの失敗を待つ</span></div>
          <div><b>Hard 17以上</b><strong>Stand</strong><strong>Stand</strong><span>HitのBustリスクが高い</span></div>
          <div><b>A,A / 8,8</b><strong>Split</strong><strong>原則Split</strong><span>16を残さず、Aを2つの強い開始手へ</span></div>
          <div><b>10,10</b><strong>Stand</strong><strong>Stand</strong><span>強い20を分けない</span></div>
          <div><b>5,5</b><strong>Double対象を確認</strong><strong>Splitしない</strong><span>2つの5ではなくHard 10として扱う</span></div>
        </div>
        <p class="cg-game-detail-note"><b>Hard / Soft</b> SoftはAを11として数えてもBustしない手。例：A+6はSoft 17。上表は早見用で、Double・Surrender・Soft handの全判断を網羅していません。</p>
      </section>

      <section class="cg-baccarat-lesson" aria-labelledby="blackjackTrapTitle">
        <div class="cg-game-detail-heading"><span>05</span><div><p>EXPENSIVE BEGINNER TRAPS</p><h5 id="blackjackTrapTitle">本線以外ほど、説明を読んでから</h5></div></div>
        <div class="cg-blackjack-traps">
          <article><b>INSURANCE</b><h6>保険ではなく別の賭け</h6><p>Dealerの表札がAの時に、Dealer Blackjackへ追加で賭けます。元の手を守る機能ではありません。初心者は使わない方が管理しやすい選択です。</p></article>
          <article><b>SIDE BET</b><h6>高配当と低い期待値</h6><p>Perfect Pairsや21+3などは本線とは別の賭けです。配当の大きさだけで選ばず、ルールとハウスエッジが分からなければ見送ります。</p></article>
          <article><b>MARTINGALE</b><h6>倍賭けで期待値は変わらない</h6><p>負けるたびに賭け額を倍にしても、テーブル上限・資金上限・連敗で破綻します。1ゲームの上限を固定します。</p></article>
        </div>
      </section>

      <section class="cg-baccarat-lesson is-last" aria-labelledby="blackjackTableCheckTitle">
        <div class="cg-game-detail-heading"><span>06</span><div><p>CHECK BEFORE YOU SIT</p><h5 id="blackjackTableCheckTitle">着席前の30秒チェック</h5></div></div>
        <ul class="cg-baccarat-check">
          <li><b>1</b><span>Blackjack配当が3:2か。6:5なら別の卓を探す</span></li>
          <li><b>2</b><span>S17 / H17、DAS、Surrender、Double条件を確認</span></li>
          <li><b>3</b><span>そのルール専用の基本戦略表を使う</span></li>
          <li><b>4</b><span>InsuranceとSide Betは本線予算へ混ぜない</span></li>
          <li><b>5</b><span>平均ベットとゲーム数を決め、総アクション額を抑える</span></li>
        </ul>
        <aside class="cg-baccarat-takeaway"><b>卓選びの優先順位</b><span><strong>3:2配当</strong>を最初に確認し、その次にS17、DAS、Double範囲、Surrenderを見ます。最低額が高くなって予算を超えるなら、条件が良くても座らないことが最善です。</span></aside>
        <p class="cg-game-detail-source">数値の基準：<a href="https://wizardofodds.com/games/blackjack/basics/" target="_blank" rel="noopener">Wizard of Odds — Blackjack Basics / Rule Variations</a>。卓固有の正確な値は、現地ルールをすべて確認した上で計算する必要があります。</p>
      </section>
    </div>
  </details>`;

const GAME_DETAILS: Readonly<Record<string, string>> = {
  baccarat: BACCARAT_DETAIL_HTML,
  blackjack: BLACKJACK_DETAIL_HTML,
};

/** 共通ゲーム解説を該当ページの差し込み位置へ描画する。 */
export function renderGameDetails(): void {
  document.querySelectorAll<HTMLElement>("[data-game-detail]").forEach((mount) => {
    const game = mount.dataset.gameDetail || "";
    const html = GAME_DETAILS[game];
    if (html) mount.innerHTML = html;
  });
}
