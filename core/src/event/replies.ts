/**
 * Fixed reply texts for the fast rules and fallbacks, in every language.
 *
 * These go out without the LLM, so they must be short, calm, always correct,
 * and instant even when the LLM is down. That is why the translations are
 * written here and committed, never made at runtime. Names and the incident
 * name come from the scenario, never from here. No phone numbers, ever.
 *
 * How it is laid out:
 *     TEMPLATES is one table: template id, then one string per language
 *     (en, es, zh, gu). Parts that change are {placeholders}, filled by
 *     render(). The `replies` functions below only pick which template to
 *     use and fill it in. A person's language goes through resolveLang, so
 *     an unknown code falls back to English.
 *
 * To add a new template:
 *     1. Add an entry to TEMPLATES with all four languages. The build fails
 *        if one is missing, and render() only accepts the {placeholders}
 *        the strings use.
 *     2. Add a function to `replies` (or your own module) that calls
 *        render("yourId", lang, { ... }), with `lang` as the last parameter
 *        defaulting to "en", so English callers keep working.
 *     3. Use withEnglish() instead of render() for safety alerts that may be
 *        read by someone who does not read the person's language.
 *
 * Translation rules:
 *     - Keep the keywords SOS, SAFE, and STOP in Latin capitals in text
 *       messages. They are what people type and what the fast rules match.
 *     - Spoken templates ("...Spoken", "fallbackVoice") use the native
 *       phrases the fast rules also understand, since nobody spells words
 *       out on a call.
 *     - Chinese has no spaces between sentences, so a placeholder that adds
 *       a sentence (like {ask}) carries its own leading space only in the
 *       languages that need one.
 */
import { resolveLang, type Lang } from "../lang/languages.js";

/** Ways Relay can be talking to someone. Voice and radio are spoken. */
export type Medium = "text" | "spoken";

/** One template in every supported language. */
type Translations = Record<Lang, string>;

/**
 * Every fixed reply, keyed by template id and then language.
 *
 * Keep each entry's {placeholders} the same in every language.
 */
export const TEMPLATES = {
  welcome: {
    en: "Welcome to Relay for the {incident}. You'll get your evacuation route and nearest shelter here.{ask} Reply SOS anytime if you need help, or STOP to opt out.",
    es: "Le damos la bienvenida a Relay para el {incident}. Aquí recibirá su ruta de evacuación y el refugio más cercano.{ask} Responda SOS en cualquier momento si necesita ayuda, o STOP para darse de baja.",
    zh: "欢迎使用 Relay（{incident}）。您将在这里收到疏散路线和最近的避难所信息。{ask}如需帮助，请随时回复 SOS；回复 STOP 可退订。",
    gu: "{incident} માટે Relay માં આપનું સ્વાગત છે. અહીં તમને તમારો સ્થળાંતર માર્ગ અને સૌથી નજીકનું આશ્રયસ્થાન મળશે.{ask} મદદની જરૂર હોય તો ગમે ત્યારે SOS મોકલો, અથવા સંદેશા બંધ કરવા STOP મોકલો.",
  },
  welcomeAskLocation: {
    en: " Please share your location so we can send your personal route.",
    es: " Comparta su ubicación para que podamos enviarle su ruta personal.",
    zh: "请分享您的位置，以便我们发送您的专属路线。",
    gu: " કૃપા કરીને તમારું લોકેશન શેર કરો, જેથી અમે તમને તમારો અંગત માર્ગ મોકલી શકીએ.",
  },
  stopped: {
    en: "You're unsubscribed from Relay alerts for the {incident}. Text us anytime to sign up again.",
    es: "Se dio de baja de las alertas de Relay para el {incident}. Escríbanos en cualquier momento para volver a inscribirse.",
    zh: "您已退订 Relay 的 {incident} 警报。如需重新订阅，随时给我们发消息即可。",
    gu: "{incident} માટેના Relay એલર્ટ હવે તમને નહીં મળે. ફરીથી જોડાવા માટે ગમે ત્યારે અમને મેસેજ કરો.",
  },
  sosText: {
    en: "Relay got your SOS, {name}. Responders are being alerted now. {where}Stay where you are safest and keep your phone on. Reply SAFE once you are out of danger.",
    es: "Relay recibió su SOS, {name}. Estamos avisando a los equipos de emergencia ahora mismo. {where}Permanezca en el lugar más seguro posible y mantenga su teléfono encendido. Responda SAFE cuando esté fuera de peligro.",
    zh: "{name}，Relay 已收到您的 SOS，正在通知救援人员。{where}请留在最安全的地方，并保持手机开机。脱离危险后请回复 SAFE。",
    gu: "{name}, Relay ને તમારો SOS મળ્યો છે. બચાવ ટીમને હમણાં જ જાણ કરવામાં આવી રહી છે. {where}જ્યાં સૌથી સુરક્ષિત હો ત્યાં જ રહો અને તમારો ફોન ચાલુ રાખો. જોખમમાંથી બહાર આવો ત્યારે SAFE મોકલો.",
  },
  sosAskLocation: {
    en: "Please share your location so responders can find you. ",
    es: "Comparta su ubicación para que los equipos de emergencia puedan encontrarle. ",
    zh: "请分享您的位置，以便救援人员找到您。",
    gu: "કૃપા કરીને તમારું લોકેશન શેર કરો, જેથી બચાવ ટીમ તમને શોધી શકે. ",
  },
  sosSpoken: {
    en: "{name}, I've marked you as needing help. Responders are being alerted now.",
    es: "{name}, registré que necesita ayuda. Estamos avisando a los equipos de emergencia ahora mismo.",
    zh: "{name}，我已记录您需要帮助，正在通知救援人员。",
    gu: "{name}, મેં નોંધ્યું છે કે તમને મદદની જરૂર છે. બચાવ ટીમને હમણાં જ જાણ કરવામાં આવી રહી છે.",
  },
  sosUnknownText: {
    en: "Relay got your SOS. Responders are being alerted now.",
    es: "Relay recibió su SOS. Estamos avisando a los equipos de emergencia ahora mismo.",
    zh: "Relay 已收到您的 SOS，正在通知救援人员。",
    gu: "Relay ને તમારો SOS મળ્યો છે. બચાવ ટીમને હમણાં જ જાણ કરવામાં આવી રહી છે.",
  },
  sosUnknownSpoken: {
    en: "I've logged your call for help. Responders are being alerted now.",
    es: "Registré su llamada de auxilio. Estamos avisando a los equipos de emergencia ahora mismo.",
    zh: "我已记录您的求助电话，正在通知救援人员。",
    gu: "મેં તમારો મદદ માટેનો કૉલ નોંધી લીધો છે. બચાવ ટીમને હમણાં જ જાણ કરવામાં આવી રહી છે.",
  },
  welcomeBack: {
    en: "Welcome back, {name}. You're signed up again for Relay alerts for the {incident}. Reply SOS anytime if you need help, or STOP to opt out.",
    es: "Hola de nuevo, {name}. Volvió a inscribirse en las alertas de Relay para el {incident}. Responda SOS en cualquier momento si necesita ayuda, o STOP para darse de baja.",
    zh: "欢迎回来，{name}。您已重新订阅 Relay 的 {incident} 警报。如需帮助，请随时回复 SOS；回复 STOP 可退订。",
    gu: "ફરી સ્વાગત છે, {name}. {incident} માટેના Relay એલર્ટ માટે તમે ફરીથી જોડાઈ ગયા છો. મદદની જરૂર હોય તો ગમે ત્યારે SOS મોકલો, અથવા સંદેશા બંધ કરવા STOP મોકલો.",
  },
  familySos: {
    en: "Relay: {name} sent an SOS during the {incident}. Responders have been alerted. We'll let you know when they're safe.",
    es: "Relay: {name} envió un SOS durante el {incident}. Ya avisamos a los equipos de emergencia. Le informaremos cuando esté a salvo.",
    zh: "Relay：{name} 在 {incident} 中发出了 SOS 求救，救援人员已收到通知。对方安全后我们会告诉您。",
    gu: "Relay: {incident} દરમિયાન {name} એ SOS મોકલ્યો છે. બચાવ ટીમને જાણ કરવામાં આવી છે. તેઓ સુરક્ષિત થશે ત્યારે અમે તમને જણાવીશું.",
  },
  safeHeld: {
    en: "Thanks, {name}. Your SOS stays open until a responder confirms you're safe.",
    es: "Gracias, {name}. Su SOS seguirá abierto hasta que un equipo de emergencia confirme que está a salvo.",
    zh: "谢谢，{name}。在救援人员确认您安全之前，您的 SOS 将保持开启。",
    gu: "આભાર, {name}. બચાવ ટીમ તમે સુરક્ષિત હોવાની પુષ્ટિ ન કરે ત્યાં સુધી તમારો SOS ચાલુ રહેશે.",
  },
  safeSpoken: {
    en: "Thanks, {name}. I've marked you safe.",
    es: "Gracias, {name}. Registré que está a salvo.",
    zh: "谢谢，{name}。我已将您标记为安全。",
    gu: "આભાર, {name}. મેં તમને સુરક્ષિત તરીકે નોંધ્યા છે.",
  },
  safeText: {
    en: "Thanks, {name}. You're marked safe. Reply SOS anytime if that changes.",
    es: "Gracias, {name}. Registramos que está a salvo. Responda SOS en cualquier momento si eso cambia.",
    zh: "谢谢，{name}。您已被标记为安全。如有变化，请随时回复 SOS。",
    gu: "આભાર, {name}. તમને સુરક્ષિત તરીકે નોંધવામાં આવ્યા છે. સ્થિતિ બદલાય તો ગમે ત્યારે SOS મોકલો.",
  },
  enRouteHeld: {
    en: "Got it, {name}. Your SOS stays open until a responder confirms you're safe.",
    es: "Entendido, {name}. Su SOS seguirá abierto hasta que un equipo de emergencia confirme que está a salvo.",
    zh: "收到，{name}。在救援人员确认您安全之前，您的 SOS 将保持开启。",
    gu: "સમજાયું, {name}. બચાવ ટીમ તમે સુરક્ષિત હોવાની પુષ્ટિ ન કરે ત્યાં સુધી તમારો SOS ચાલુ રહેશે.",
  },
  enRouteSpoken: {
    en: "Got it, {name}. I've marked you as on your way. Drive safely.",
    es: "Entendido, {name}. Registré que va en camino. Maneje con cuidado.",
    zh: "收到，{name}。我已将您标记为正在撤离途中。请小心驾驶。",
    gu: "સમજાયું, {name}. મેં નોંધ્યું છે કે તમે નીકળી ગયા છો. સાવચેતીથી વાહન ચલાવજો.",
  },
  enRouteText: {
    en: "Got it, {name}. You're marked as on your way. Reply SAFE when you arrive, or SOS if you need help.",
    es: "Entendido, {name}. Registramos que va en camino. Responda SAFE cuando llegue, o SOS si necesita ayuda.",
    zh: "收到，{name}。您已被标记为正在撤离途中。到达后请回复 SAFE，如需帮助请回复 SOS。",
    gu: "સમજાયું, {name}. તમે રસ્તામાં છો એવું નોંધવામાં આવ્યું છે. પહોંચી જાઓ ત્યારે SAFE મોકલો, અથવા મદદ જોઈએ તો SOS મોકલો.",
  },
  locationThanks: {
    en: "Thanks, {name}. We have your location and will text your route and nearest shelter if an alert reaches your area.",
    es: "Gracias, {name}. Ya tenemos su ubicación. Si una alerta llega a su zona, le enviaremos por mensaje su ruta y el refugio más cercano.",
    zh: "谢谢，{name}。我们已收到您的位置。如果您所在区域发布警报，我们会发短信告诉您路线和最近的避难所。",
    gu: "આભાર, {name}. અમને તમારું લોકેશન મળી ગયું છે. જો તમારા વિસ્તારમાં એલર્ટ આવશે, તો અમે તમને તમારો માર્ગ અને સૌથી નજીકનું આશ્રયસ્થાન મેસેજ કરીશું.",
  },
  fallbackText: {
    en: "Relay here for the {incident}. Reply SAFE if you are safe, SOS if you need help, or STOP to opt out.",
    es: "Le escribe Relay sobre el {incident}. Responda SAFE si está a salvo, SOS si necesita ayuda, o STOP para darse de baja.",
    zh: "这里是 Relay（{incident}）。安全请回复 SAFE，需要帮助请回复 SOS，回复 STOP 可退订。",
    gu: "{incident} માટે Relay અહીં છે. તમે સુરક્ષિત હો તો SAFE, મદદ જોઈએ તો SOS, અથવા સંદેશા બંધ કરવા STOP મોકલો.",
  },
  fallbackVoice: {
    en: "This is Relay. Say safe if you are safe, or help if you need help.",
    es: "Le habla Relay. Diga «estoy bien» si está a salvo, o «ayuda» si necesita ayuda.",
    zh: "这里是 Relay。如果您安全，请说“我安全了”；如果需要帮助，请说“救命”。",
    gu: "આ Relay છે. તમે સુરક્ષિત હો તો 'હું સુરક્ષિત છું' બોલો, અથવા મદદ જોઈએ તો 'મદદ' બોલો.",
  },
  fallbackRadio: {
    en: "Relay copies. I can't answer that right now. Stand by.",
    es: "Relay, copiado. No puedo responder eso en este momento. Manténgase a la escucha.",
    zh: "Relay 收到。暂时无法回答，请待命。",
    gu: "Relay ને સંદેશ મળ્યો. અત્યારે આનો જવાબ આપી શકાય તેમ નથી. રાહ જુઓ.",
  },
  fireAlert: {
    en: "Relay alert for the {incident}, {name}: {where}.{shelter} Reply SAFE if you are safe, or SOS if you need help.",
    es: "Alerta de Relay por el {incident}, {name}: {where}.{shelter} Responda SAFE si está a salvo, o SOS si necesita ayuda.",
    zh: "Relay 警报（{incident}），{name}：{where}。{shelter}安全请回复 SAFE，需要帮助请回复 SOS。",
    gu: "{incident} માટે Relay એલર્ટ, {name}: {where}.{shelter} તમે સુરક્ષિત હો તો SAFE, અથવા મદદ જોઈએ તો SOS મોકલો.",
  },
  fireWhereOutside: {
    en: "the fire is {km} km {direction} of you",
    es: "el incendio está a {km} km al {direction} de usted",
    zh: "火场在您的{direction}方向 {km} 公里处",
    gu: "આગ તમારાથી {direction} દિશામાં {km} કિમી દૂર છે",
  },
  fireWhereInside: {
    en: "you are inside the fire area",
    es: "usted está dentro de la zona del incendio",
    zh: "您位于火灾区域内",
    gu: "તમે આગના વિસ્તારની અંદર છો",
  },
  fireShelterRoute: {
    en: " Nearest shelter: {shelter}, {km} km, about {min} min by car.",
    es: " Refugio más cercano: {shelter}, a {km} km, unos {min} min en coche.",
    zh: "最近的避难所：{shelter}，距离 {km} 公里，开车约 {min} 分钟。",
    gu: " સૌથી નજીકનું આશ્રયસ્થાન: {shelter}, {km} કિમી, કાર દ્વારા આશરે {min} મિનિટ.",
  },
  fireShelterNoRoute: {
    en: " Nearest shelter: {shelter}, {km} km away.",
    es: " Refugio más cercano: {shelter}, a {km} km.",
    zh: "最近的避难所：{shelter}，距离 {km} 公里。",
    gu: " સૌથી નજીકનું આશ્રયસ્થાન: {shelter}, {km} કિમી દૂર.",
  },
  checkinCall: {
    en: "This is Relay, the service that just texted you about the {incident}. Are you safe right now? Say yes if you are safe, or help if you need help.",
    es: "Le habla Relay, el servicio que acaba de enviarle un mensaje sobre el {incident}. ¿Está a salvo ahora mismo? Diga «sí» si está a salvo, o «ayuda» si necesita ayuda.",
    zh: "这里是 Relay，刚才给您发短信通知{incident}的服务。您现在安全吗？如果安全，请说“是”；如果需要帮助，请说“救命”。",
    gu: "આ Relay છે, જેણે હમણાં જ તમને {incident} વિશે મેસેજ કર્યો હતો. શું તમે અત્યારે સુરક્ષિત છો? સુરક્ષિત હો તો 'હા' બોલો, અથવા મદદ જોઈએ તો 'મદદ' બોલો.",
  },
  familyCall: {
    en: "This is Relay, calling about the {incident}. We sent {name} a fire alert and called them, but could not reach them. If you can, please try to reach {name} and ask them to text Relay back. Responders are being told. Are you safe yourself? Say yes if you are safe, or help if you need help.",
    es: "Le habla Relay, por el {incident}. Le enviamos a {name} una alerta de incendio y le llamamos, pero no logramos comunicarnos. Si puede, intente comunicarse con {name} y pídale que le responda a Relay por mensaje. Ya estamos avisando a los equipos de emergencia. ¿Usted está a salvo? Diga «sí» si está a salvo, o «ayuda» si necesita ayuda.",
    zh: "这里是 Relay，来电是关于{incident}。我们给 {name} 发了火灾警报并打了电话，但联系不上。如果可以，请尝试联系 {name}，请对方回复 Relay 的短信。我们正在通知救援人员。您自己安全吗？如果安全，请说“是”；如果需要帮助，请说“救命”。",
    gu: "આ Relay છે, {incident} વિશે ફોન કરી રહ્યા છીએ. અમે {name} ને આગનું એલર્ટ મોકલ્યું અને ફોન કર્યો, પણ સંપર્ક થઈ શક્યો નહીં. જો શક્ય હોય તો {name} નો સંપર્ક કરો અને તેમને Relay ને મેસેજથી જવાબ આપવા કહો. બચાવ ટીમને જાણ કરવામાં આવી રહી છે. શું તમે પોતે સુરક્ષિત છો? સુરક્ષિત હો તો 'હા' બોલો, અથવા મદદ જોઈએ તો 'મદદ' બોલો.",
  },
} as const satisfies Record<string, Translations>;

/**
 * Compass words for fire alerts, keyed by the English word that
 * compassDirection returns.
 */
const DIRECTIONS = {
  north: { en: "north", es: "norte", zh: "北", gu: "ઉત્તર" },
  northeast: { en: "northeast", es: "noreste", zh: "东北", gu: "ઉત્તર-પૂર્વ" },
  east: { en: "east", es: "este", zh: "东", gu: "પૂર્વ" },
  southeast: { en: "southeast", es: "sureste", zh: "东南", gu: "દક્ષિણ-પૂર્વ" },
  south: { en: "south", es: "sur", zh: "南", gu: "દક્ષિણ" },
  southwest: { en: "southwest", es: "suroeste", zh: "西南", gu: "દક્ષિણ-પશ્ચિમ" },
  west: { en: "west", es: "oeste", zh: "西", gu: "પશ્ચિમ" },
  northwest: { en: "northwest", es: "noroeste", zh: "西北", gu: "ઉત્તર-પશ્ચિમ" },
} as const satisfies Record<string, Translations>;

/**
 * Translate a compass word.
 *
 * Args:
 *     word (string): English compass word, e.g. "northeast".
 *     lang (string): A language code.
 *
 * Returns:
 *     string: The word in that language, or the English word if it is not
 *         one of the eight compass points.
 */
function direction(word: string, lang: string): string {
  const entry = (DIRECTIONS as Record<string, Translations>)[word];
  return entry ? entry[resolveLang(lang)] : word;
}

/** The id of a fixed reply template. */
export type TemplateId = keyof typeof TEMPLATES;

/** The {placeholder} names used in a template string. */
type Placeholders<S extends string> = S extends `${string}{${infer Key}}${infer Rest}` ? Key | Placeholders<Rest> : never;

/** The values a template needs, one per {placeholder} in any of its languages. */
export type TemplateVars<Id extends TemplateId> = Record<Placeholders<(typeof TEMPLATES)[Id][Lang]>, string>;

/**
 * Fill in one template in one language.
 *
 * Args:
 *     id (TemplateId): Which template.
 *     lang (string): A language code. Unknown codes fall back to English.
 *     vars (TemplateVars): A value for every {placeholder} in the template.
 *
 * Returns:
 *     string: The finished text. A placeholder with no value is left out
 *         rather than sent as "{name}".
 */
export function render<Id extends TemplateId>(id: Id, lang: string, vars: TemplateVars<Id>): string {
  const template: string = TEMPLATES[id][resolveLang(lang)];
  const values = vars as Record<string, string>;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

/**
 * Fill in a template in the person's language, followed by the English.
 *
 * For safety alerts that someone else may read, e.g. a family member's
 * phone. English speakers get the English once.
 *
 * Args:
 *     id (TemplateId): Which template.
 *     lang (string): A language code.
 *     vars (TemplateVars): A value for every {placeholder}.
 *
 * Returns:
 *     string: The native text, a blank line, then the English text.
 */
export function withEnglish<Id extends TemplateId>(id: Id, lang: string, vars: TemplateVars<Id>): string {
  const english = render(id, "en", vars);
  return resolveLang(lang) === "en" ? english : `${render(id, lang, vars)}\n\n${english}`;
}

export const replies = {
  /**
   * Welcome for someone who just signed up by texting Relay.
   *
   * Args:
   *     incident (string): Incident name.
   *     hasLocation (boolean): Whether they already shared a location.
   *     lang (string): Their language. Defaults to English.
   *
   * Returns:
   *     string: The welcome text.
   */
  welcome(incident: string, hasLocation: boolean, lang = "en"): string {
    const ask = hasLocation ? "" : render("welcomeAskLocation", lang, {});
    return render("welcome", lang, { incident, ask });
  },

  /**
   * Confirmation after STOP.
   *
   * Args:
   *     incident (string): Incident name.
   *     lang (string): Their language. Defaults to English.
   *
   * Returns:
   *     string: The opt-out text.
   */
  stopped(incident: string, lang = "en"): string {
    return render("stopped", lang, { incident });
  },

  /**
   * Reply to someone who sent an SOS.
   *
   * Args:
   *     name (string): Their name.
   *     medium (Medium): Text or spoken.
   *     hasLocation (boolean): Whether Relay knows where they are. If not,
   *         the text asks them to share it so responders can find them.
   *     lang (string): Their language. Defaults to English.
   *
   * Returns:
   *     string: The SOS acknowledgement.
   */
  sos(name: string, medium: Medium, hasLocation: boolean, lang = "en"): string {
    if (medium === "spoken") return render("sosSpoken", lang, { name });
    const where = hasLocation ? "" : render("sosAskLocation", lang, {});
    return render("sosText", lang, { name, where });
  },

  /**
   * Reply to an SOS from a sender Relay does not know, such as a caller.
   *
   * Args:
   *     medium (Medium): Text or spoken.
   *     lang (string): The language of their message. Defaults to English.
   *
   * Returns:
   *     string: The acknowledgement.
   */
  sosUnknown(medium: Medium, lang = "en"): string {
    return render(medium === "spoken" ? "sosUnknownSpoken" : "sosUnknownText", lang, {});
  },

  /**
   * Welcome back someone who sent STOP and then texted again.
   *
   * Args:
   *     name (string): Their name.
   *     incident (string): Incident name.
   *     lang (string): Their language. Defaults to English.
   *
   * Returns:
   *     string: The welcome back text.
   */
  welcomeBack(name: string, incident: string, lang = "en"): string {
    return render("welcomeBack", lang, { name, incident });
  },

  /**
   * Text to a family contact when their person sends an SOS.
   *
   * This is a safety alert, so a non-English text also carries the English
   * below it, in case the language on file is wrong or someone else reads it.
   *
   * Args:
   *     name (string): The person who sent the SOS.
   *     incident (string): Incident name.
   *     lang (string): The family contact's language. Defaults to English.
   *
   * Returns:
   *     string: The family alert.
   */
  familySos(name: string, incident: string, lang = "en"): string {
    return withEnglish("familySos", lang, { name, incident });
  },

  /**
   * Reply to someone who said they are safe.
   *
   * Args:
   *     name (string): Their name.
   *     held (boolean): True if they are in SOS, which stays open until a
   *         responder confirms.
   *     medium (Medium): Text or spoken.
   *     lang (string): Their language. Defaults to English.
   *
   * Returns:
   *     string: The confirmation.
   */
  safe(name: string, held: boolean, medium: Medium, lang = "en"): string {
    if (held) return render("safeHeld", lang, { name });
    return render(medium === "spoken" ? "safeSpoken" : "safeText", lang, { name });
  },

  /**
   * Reply to someone who said they are leaving.
   *
   * Args:
   *     name (string): Their name.
   *     held (boolean): True if they are in SOS.
   *     medium (Medium): Text or spoken.
   *     lang (string): Their language. Defaults to English.
   *
   * Returns:
   *     string: The confirmation.
   */
  enRoute(name: string, held: boolean, medium: Medium, lang = "en"): string {
    if (held) return render("enRouteHeld", lang, { name });
    return render(medium === "spoken" ? "enRouteSpoken" : "enRouteText", lang, { name });
  },

  /**
   * Reply to a location share with no text.
   *
   * Args:
   *     name (string): Their name.
   *     lang (string): Their language. Defaults to English.
   *
   * Returns:
   *     string: The confirmation.
   */
  locationThanks(name: string, lang = "en"): string {
    return render("locationThanks", lang, { name });
  },

  /**
   * Fallback when no rule matched and the agent is not available.
   *
   * Args:
   *     incident (string): Incident name.
   *     channel ("text" | "voice" | "radio"): Where the message came from.
   *     lang (string): The sender's language. Defaults to English.
   *
   * Returns:
   *     string: A short reply that still tells people what they can do.
   */
  fallback(incident: string, channel: "text" | "voice" | "radio", lang = "en"): string {
    if (channel === "radio") return render("fallbackRadio", lang, {});
    if (channel === "voice") return render("fallbackVoice", lang, {});
    return render("fallbackText", lang, { incident });
  },

  /**
   * Fire alert text the hazard watcher sends to someone near a fire.
   *
   * It is a safety alert, so like familySos it is sent in the person's
   * language followed by the English, in case someone else reads it.
   *
   * Args:
   *     alert (FireAlert): Who, how far, which way, and the nearest shelter.
   *     lang (string): Their language. Defaults to English.
   *
   * Returns:
   *     string: The alert text.
   */
  fireAlert(alert: FireAlert, lang = "en"): string {
    const one = (l: string): string => {
      const where = alert.inside
        ? render("fireWhereInside", l, {})
        : render("fireWhereOutside", l, { km: km(alert.fireKm), direction: direction(alert.direction, l) });
      let shelter = "";
      if (alert.shelter) {
        const s = alert.shelter;
        shelter =
          s.minutes === null
            ? render("fireShelterNoRoute", l, { shelter: s.name, km: km(s.km) })
            : render("fireShelterRoute", l, { shelter: s.name, km: km(s.km), min: minutes(s.minutes) });
      }
      return render("fireAlert", l, { incident: alert.incident, name: alert.name, where, shelter });
    };
    const english = one("en");
    return resolveLang(lang) === "en" ? english : `${one(lang)}\n\n${english}`;
  },

  /**
   * Script for the check-in call when someone does not answer an alert.
   *
   * It asks "Are you safe" on purpose: a bare "yes" on a call counts as safe
   * in the fast rules, so the question has to make "yes" mean safe.
   *
   * Args:
   *     incident (string): Incident name.
   *     lang (string): Their language. Defaults to English.
   *
   * Returns:
   *     string: The spoken script.
   */
  checkinCall(incident: string, lang = "en"): string {
    return render("checkinCall", lang, { incident });
  },

  /**
   * Script for the call to a family contact when Relay cannot reach someone.
   *
   * It ends by asking whether the family member is safe, so a "yes" or "ok"
   * from them only ever marks themselves safe, never the missing person.
   *
   * Args:
   *     name (string): The person Relay cannot reach.
   *     incident (string): Incident name.
   *     lang (string): The family contact's language. Defaults to English.
   *
   * Returns:
   *     string: The spoken script.
   */
  familyCall(name: string, incident: string, lang = "en"): string {
    return render("familyCall", lang, { name, incident });
  },

  /**
   * Spoken briefing for the emergency call a responder confirmed.
   *
   * Args:
   *     brief (EmergencyBrief): Who needs help, where, and for how long.
   *
   * Returns:
   *     string: The spoken script.
   */
  emergencyBriefing(brief: EmergencyBrief): string {
    const parts = [
      `This is Relay, an automated evacuation service for the ${brief.incident}. A responder confirmed this call.`,
      `${brief.name} needs help.`,
      `Last known location: ${brief.where}.`,
      `They have been flagged as needing help for ${duration(brief.sosMinutes)}.`,
    ];
    if (brief.lastMessage) parts.push(`Their last message was: ${brief.lastMessage}.`);
    return parts.join(" ");
  },
};

/**
 * What goes into a fire alert.
 *
 * Attributes:
 *     name (string): The person being alerted.
 *     incident (string): Incident name.
 *     fireKm (number): Distance from them to the fire's edge, in km.
 *     direction (string): Compass word from them to the fire, e.g. "northeast".
 *     inside (boolean): True if they are inside the fire circle.
 *     shelter ({ name, km, minutes } | null): Nearest shelter. `km` is the
 *         route length (or straight-line distance if routing failed), and
 *         `minutes` the drive time, or null if routing failed.
 */
export interface FireAlert {
  name: string;
  incident: string;
  fireKm: number;
  direction: string;
  inside: boolean;
  shelter: { name: string; km: number; minutes: number | null } | null;
}

/**
 * What goes into the emergency briefing.
 *
 * Attributes:
 *     name (string): The person in SOS.
 *     incident (string): Incident name.
 *     where (string): Spoken location, e.g. "Zone 3, about 0.4 km from Oak St".
 *     sosMinutes (number): How long they have been in SOS.
 *     lastMessage (string | null): Their last message, if any.
 */
export interface EmergencyBrief {
  name: string;
  incident: string;
  where: string;
  sosMinutes: number;
  lastMessage: string | null;
}

/**
 * Format a distance for a text, to one decimal place.
 *
 * Args:
 *     value (number): Kilometres.
 *
 * Returns:
 *     string: e.g. "2.3".
 */
function km(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/**
 * Format a drive time in whole minutes, never less than one.
 *
 * Args:
 *     value (number): Minutes.
 *
 * Returns:
 *     string: e.g. "6".
 */
function minutes(value: number): string {
  return String(Math.max(1, Math.ceil(value)));
}

/**
 * Say how long something has lasted.
 *
 * Args:
 *     mins (number): Minutes, possibly fractional.
 *
 * Returns:
 *     string: "less than a minute", "1 minute", or "N minutes".
 */
function duration(mins: number): string {
  const whole = Math.floor(mins);
  if (whole < 1) return "less than a minute";
  return whole === 1 ? "1 minute" : `${whole} minutes`;
}
