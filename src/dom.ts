/**
 * Aplicacion incremental de HTML sobre el DOM ya montado.
 *
 * Antes la interfaz se repintaba con `root.innerHTML = renderApp()` una vez por
 * segundo. Eso destruye y recrea TODOS los nodos, de modo que:
 *
 *   - un `<select>` desplegado se cerraba al instante (el elemento sobre el que
 *     el sistema habia abierto el desplegable dejaba de existir),
 *   - se perdian foco, seleccion de texto, desplazamiento y estado de `<details>`,
 *   - el mapa de Leaflet habia que reconstruirlo entero.
 *
 * `patch()` compara el HTML nuevo con el DOM vivo y toca unicamente lo que ha
 * cambiado: si un subarbol es identico, sus nodos ni se rozan. Con eso el
 * refresco de "hace 12 s" ya no cierra ningun desplegable.
 *
 * Reglas de conservacion:
 *   - `data-morph="skip"`: el contenido lo gestiona otro (Leaflet); no se toca.
 *   - `data-key`: identidad estable dentro de una lista; permite reordenar sin
 *     recrear los elementos.
 *   - Campos de formulario: nunca se sobrescribe lo que la persona esta editando.
 */

/** Atributos que reflejan estado vivo y no deben imponerse desde el HTML. */
const LIVE_VALUE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function patch(root: HTMLElement, html: string): void {
  const template = document.createElement('template')
  template.innerHTML = html
  morphChildren(root, template.content)
}

function morphChildren(parent: Node, source: Node): void {
  const oldNodes = Array.from(parent.childNodes)
  const newNodes = Array.from(source.childNodes)

  // Indice por clave para poder reordenar sin recrear.
  const keyed = new Map<string, ChildNode>()
  for (const node of oldNodes) {
    const key = keyOf(node)
    if (key) {
      keyed.set(key, node)
    }
  }

  const kept = new Set<ChildNode>()
  let cursor: ChildNode | null = parent.firstChild

  for (const next of newNodes) {
    const key = keyOf(next)
    const reusable = key ? keyed.get(key) : null

    if (reusable) {
      if (reusable !== cursor) {
        parent.insertBefore(reusable, cursor)
      } else {
        cursor = cursor.nextSibling
      }
      morphNode(reusable, next)
      kept.add(reusable)
      continue
    }

    if (cursor && !keyOf(cursor) && compatible(cursor, next)) {
      morphNode(cursor, next)
      kept.add(cursor)
      cursor = cursor.nextSibling
      continue
    }

    const inserted = document.importNode(next, true)
    parent.insertBefore(inserted, cursor)
    kept.add(inserted as ChildNode)
  }

  for (const node of Array.from(parent.childNodes)) {
    if (!kept.has(node)) {
      parent.removeChild(node)
    }
  }
}

function keyOf(node: Node): string | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element).getAttribute('data-key') : null
}

function compatible(left: Node, right: Node): boolean {
  if (left.nodeType !== right.nodeType) {
    return false
  }
  if (left.nodeType !== Node.ELEMENT_NODE) {
    return true
  }
  return (left as Element).tagName === (right as Element).tagName
}

function morphNode(target: Node, source: Node): void {
  if (target.nodeType !== Node.ELEMENT_NODE) {
    if (target.nodeValue !== source.nodeValue) {
      target.nodeValue = source.nodeValue
    }
    return
  }

  const element = target as HTMLElement
  const next = source as HTMLElement

  // Lo gestiona otro (Leaflet escribe sus propias clases y su propio contenido
  // dentro del contenedor del mapa): ni atributos ni hijos.
  if (element.dataset.morph === 'skip') {
    return
  }

  morphAttributes(element, next)

  morphChildren(element, next)
  syncFormState(element, next)
}

function morphAttributes(element: HTMLElement, next: HTMLElement): void {
  for (const attribute of Array.from(next.attributes)) {
    if (element.getAttribute(attribute.name) !== attribute.value) {
      element.setAttribute(attribute.name, attribute.value)
    }
  }

  for (const attribute of Array.from(element.attributes)) {
    if (!next.hasAttribute(attribute.name)) {
      element.removeAttribute(attribute.name)
    }
  }
}

/**
 * Los atributos no bastan: `value`, `checked` y la opcion seleccionada de un
 * `<select>` viven en propiedades. Se sincronizan solo si el elemento no tiene
 * el foco, para no pisar lo que se esta escribiendo o eligiendo.
 */
function syncFormState(element: HTMLElement, next: HTMLElement): void {
  if (!LIVE_VALUE_TAGS.has(element.tagName) || document.activeElement === element) {
    return
  }

  if (element instanceof HTMLSelectElement && next instanceof HTMLSelectElement) {
    const desired = Array.from(next.querySelectorAll('option')).find((option) =>
      option.hasAttribute('selected'),
    )?.value
    if (desired !== undefined && element.value !== desired) {
      element.value = desired
    }
    return
  }

  if (element instanceof HTMLInputElement && next instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      const checked = next.hasAttribute('checked')
      if (element.checked !== checked) {
        element.checked = checked
      }
      return
    }
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const value = next.getAttribute('value') ?? (next as HTMLTextAreaElement).textContent ?? ''
    if (element.value !== value) {
      element.value = value
    }
  }
}
