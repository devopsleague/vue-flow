import type { D3DragEvent, DragBehavior, SubjectPosition } from 'd3-drag'
import { drag } from 'd3-drag'
import { select } from 'd3-selection'
import type { MaybeRefOrGetter, Ref } from 'vue'
import { ref, toValue, watch } from 'vue'
import type { NodeDragEvent, NodeDragItem, XYPosition } from '../types'
import {
  calcAutoPan,
  calcNextPosition,
  getDragItems,
  getEventHandlerParams,
  getEventPosition,
  handleNodeClick,
  hasSelector,
} from '../utils'
import { useGetPointerPosition, useVueFlow } from '.'

export type UseDragEvent = D3DragEvent<HTMLDivElement, null, SubjectPosition>

interface UseDragParams {
  onStart: (event: NodeDragEvent) => void
  onDrag: (event: NodeDragEvent) => void
  onStop: (event: NodeDragEvent) => void
  onClick?: (event: MouseEvent) => void
  el: Ref<Element | null>
  disabled?: MaybeRefOrGetter<boolean>
  selectable?: MaybeRefOrGetter<boolean>
  dragHandle?: MaybeRefOrGetter<string | undefined>
  id?: string
}

/**
 * Composable that provides drag behavior for nodes
 *
 * @internal
 * @param params
 */
export function useDrag(params: UseDragParams) {
  const {
    vueFlowRef,
    snapToGrid,
    snapGrid,
    noDragClassName,
    nodes,
    nodeExtent,
    nodeDragThreshold,
    viewport,
    autoPanOnNodeDrag,
    autoPanSpeed,
    nodesDraggable,
    panBy,
    getNode,
    multiSelectionActive,
    nodesSelectionActive,
    selectNodesOnDrag,
    removeSelectedNodes,
    addSelectedNodes,
    updateNodePositions,
    emits,
  } = useVueFlow()

  const { onStart, onDrag, onStop, onClick, el, disabled, id, selectable, dragHandle } = params

  const dragging = ref(false)

  let dragItems: NodeDragItem[] = []

  let dragHandler: DragBehavior<Element, unknown, unknown>

  let containerBounds: DOMRect | null = null

  let lastPos: Partial<XYPosition> = { x: undefined, y: undefined }
  let mousePosition: XYPosition = { x: 0, y: 0 }
  let dragEvent: MouseEvent | null = null
  let dragStarted = false

  let autoPanId = 0
  let autoPanStarted = false

  const getPointerPosition = useGetPointerPosition()

  const updateNodes = ({ x, y }: XYPosition) => {
    lastPos = { x, y }

    let hasChange = false

    dragItems = dragItems.map((n) => {
      const nextPosition = { x: x - n.distance.x, y: y - n.distance.y }

      if (snapToGrid.value) {
        nextPosition.x = snapGrid.value[0] * Math.round(nextPosition.x / snapGrid.value[0])
        nextPosition.y = snapGrid.value[1] * Math.round(nextPosition.y / snapGrid.value[1])
      }

      const { computedPosition } = calcNextPosition(
        n,
        nextPosition,
        emits.error,
        nodeExtent.value,
        n.parentNode ? getNode(n.parentNode) : undefined,
      )

      // we want to make sure that we only fire a change event when there is a change
      hasChange = hasChange || n.position.x !== computedPosition.x || n.position.y !== computedPosition.y

      n.position = computedPosition

      return n
    })

    if (!hasChange) {
      return
    }

    updateNodePositions(dragItems, true, true)

    dragging.value = true

    if (dragEvent) {
      const [currentNode, nodes] = getEventHandlerParams({
        id,
        dragItems,
        findNode: getNode,
      })

      onDrag({ event: dragEvent, node: currentNode, nodes })
    }
  }

  const autoPan = () => {
    if (!containerBounds) {
      return
    }

    const [xMovement, yMovement] = calcAutoPan(mousePosition, containerBounds, autoPanSpeed.value)

    if (xMovement !== 0 || yMovement !== 0) {
      const nextPos = {
        x: (lastPos.x ?? 0) - xMovement / viewport.value.zoom,
        y: (lastPos.y ?? 0) - yMovement / viewport.value.zoom,
      }

      if (panBy({ x: xMovement, y: yMovement })) {
        updateNodes(nextPos)
      }
    }

    autoPanId = requestAnimationFrame(autoPan)
  }

  const startDrag = (event: UseDragEvent, nodeEl: Element) => {
    dragStarted = true

    const node = getNode(id!)
    if (!selectNodesOnDrag.value && !multiSelectionActive.value && node) {
      if (!node.selected) {
        // we need to reset selected nodes when selectNodesOnDrag=false
        removeSelectedNodes()
      }
    }

    if (node && toValue(selectable) && selectNodesOnDrag.value) {
      handleNodeClick(
        node,
        multiSelectionActive.value,
        addSelectedNodes,
        removeSelectedNodes,
        nodesSelectionActive,
        false,
        nodeEl as HTMLDivElement,
      )
    }

    const pointerPos = getPointerPosition(event)
    lastPos = pointerPos
    dragItems = getDragItems(nodes.value, nodesDraggable.value, pointerPos, getNode, id)

    if (dragItems.length) {
      const [currentNode, nodes] = getEventHandlerParams({
        id,
        dragItems,
        findNode: getNode,
      })

      onStart({ event: event.sourceEvent, node: currentNode, nodes })
    }
  }

  const eventStart = (event: UseDragEvent, nodeEl: Element) => {
    if (event.sourceEvent.type === 'touchmove' && event.sourceEvent.touches.length > 1) {
      return
    }

    if (nodeDragThreshold.value === 0) {
      startDrag(event, nodeEl)
    }

    lastPos = getPointerPosition(event)

    containerBounds = vueFlowRef.value?.getBoundingClientRect() || null
    mousePosition = getEventPosition(event.sourceEvent, containerBounds!)
  }

  const eventDrag = (event: UseDragEvent, nodeEl: Element) => {
    const pointerPos = getPointerPosition(event)

    if (!autoPanStarted && dragStarted && autoPanOnNodeDrag.value) {
      autoPanStarted = true
      autoPan()
    }

    if (!dragStarted) {
      const x = pointerPos.xSnapped - (lastPos.x ?? 0)
      const y = pointerPos.ySnapped - (lastPos.y ?? 0)
      const distance = Math.sqrt(x * x + y * y)

      if (distance > nodeDragThreshold.value) {
        startDrag(event, nodeEl)
      }
    }

    // skip events without movement
    if ((lastPos.x !== pointerPos.xSnapped || lastPos.y !== pointerPos.ySnapped) && dragItems.length && dragStarted) {
      dragEvent = event.sourceEvent as MouseEvent
      mousePosition = getEventPosition(event.sourceEvent, containerBounds!)

      updateNodes(pointerPos)
    }
  }

  const eventEnd = (event: UseDragEvent) => {
    if (!dragStarted) {
      const pointerPos = getPointerPosition(event)

      const x = pointerPos.xSnapped - (lastPos.x ?? 0)
      const y = pointerPos.ySnapped - (lastPos.y ?? 0)
      const distance = Math.sqrt(x * x + y * y)

      // dispatch a click event if the node was attempted to be dragged but the threshold was not exceeded
      if (distance !== 0 && distance <= nodeDragThreshold.value) {
        onClick?.(event.sourceEvent)
      }

      return
    }

    dragging.value = false
    autoPanStarted = false
    dragStarted = false

    cancelAnimationFrame(autoPanId)

    if (dragItems.length) {
      updateNodePositions(dragItems, false, false)

      const [currentNode, nodes] = getEventHandlerParams({
        id,
        dragItems,
        findNode: getNode,
      })

      onStop({ event: event.sourceEvent, node: currentNode, nodes })
    }
  }

  watch([() => toValue(disabled), el], ([isDisabled, nodeEl], _, onCleanup) => {
    if (nodeEl) {
      const selection = select(nodeEl)

      if (!isDisabled) {
        dragHandler = drag()
          .on('start', (event: UseDragEvent) => eventStart(event, nodeEl))
          .on('drag', (event: UseDragEvent) => eventDrag(event, nodeEl))
          .on('end', (event: UseDragEvent) => eventEnd(event))
          .filter((event: D3DragEvent<HTMLDivElement, null, SubjectPosition>['sourceEvent']) => {
            const target = event.target as HTMLDivElement
            const unrefDragHandle = toValue(dragHandle)

            return (
              !event.button &&
              (!noDragClassName.value ||
                (!hasSelector(target, `.${noDragClassName.value}`, nodeEl) &&
                  (!unrefDragHandle || hasSelector(target, unrefDragHandle, nodeEl))))
            )
          })

        selection.call(dragHandler)
      }

      onCleanup(() => {
        selection.on('.drag', null)

        if (dragHandler) {
          dragHandler.on('start', null)
          dragHandler.on('drag', null)
          dragHandler.on('end', null)
        }
      })
    }
  })

  return dragging
}
