import {
  noop,
  forEachChildNodes,
  isNodeShadowHost,
  getParentNode,
  isNullUndefinedDefaultValue,
  monitor
} from '@cloudcare/browser-core'
import { getMutationObserverConstructor } from '../../domMutationObservable'
import { NodePrivacyLevel } from '../../../constants'
import { getNodePrivacyLevel, getTextContent } from './privacy'
import {
  getElementInputValue,
  getSerializedNodeId,
  hasSerializedNode,
  nodeAndAncestorsHaveSerializedNode
} from './serializationUtils'
import {
  serializeNodeWithId,
  serializeAttribute,
  SerializationContextStatus
} from './serialize'
import { createMutationBatch } from './mutationBatch'

/**
 * Buffers and aggregate mutations generated by a MutationObserver into MutationPayload
 */
export function startMutationObserver(
  mutationCallback,
  configuration,
  shadowRootsController,
  target
) {
  var MutationObserver = getMutationObserverConstructor()
  if (!MutationObserver) {
    return { stop: noop, flush: noop }
  }

  var mutationBatch = createMutationBatch(function (mutations) {
    processMutations(
      mutations.concat(observer.takeRecords()),
      mutationCallback,
      configuration,
      shadowRootsController
    )
  })

  var observer = new MutationObserver(monitor(mutationBatch.addMutations))

  observer.observe(target, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    characterDataOldValue: true,
    childList: true,
    subtree: true
  })

  return {
    stop: function () {
      observer.disconnect()
      mutationBatch.stop()
    },
    flush: function () {
      mutationBatch.flush()
    }
  }
}

function processMutations(
  mutations,
  mutationCallback,
  configuration,
  shadowRootsController
) {
  var nodePrivacyLevelCache = new Map()
  mutations
    .filter(function (mutation) {
      return mutation.type === 'childList'
    })
    .forEach(function (mutation) {
      mutation.removedNodes.forEach(function (removedNode) {
        traverseRemovedShadowDom(
          removedNode,
          shadowRootsController.removeShadowRoot
        )
      })
    })

  // Discard any mutation with a 'target' node that:
  // * isn't injected in the current document or isn't known/serialized yet: those nodes are likely
  // part of a mutation occurring in a parent Node
  // * should be hidden or ignored
  var filteredMutations = mutations.filter(function (mutation) {
    return (
      mutation.target.isConnected &&
      nodeAndAncestorsHaveSerializedNode(mutation.target) &&
      getNodePrivacyLevel(
        mutation.target,
        configuration.defaultPrivacyLevel,
        nodePrivacyLevelCache
      ) !== NodePrivacyLevel.HIDDEN
    )
  })
  var _processChildListMutations = processChildListMutations(
    filteredMutations.filter(function (mutation) {
      return mutation.type === 'childList'
    }),
    configuration,
    shadowRootsController,
    nodePrivacyLevelCache
  )
  var adds = _processChildListMutations.adds
  var removes = _processChildListMutations.removes
  //   var hasBeenSerialized = _processChildListMutations.hasBeenSerialized
  var serializedNodeIds = _processChildListMutations.serializedNodeIds
  function hasBeenSerialized(node) {
    return (
      hasSerializedNode(node) &&
      serializedNodeIds.has(getSerializedNodeId(node))
    )
  }
  var texts = processCharacterDataMutations(
    filteredMutations.filter(function (mutation) {
      return (
        mutation.type === 'characterData' && !hasBeenSerialized(mutation.target)
      )
    }),
    configuration,
    nodePrivacyLevelCache
  )

  var attributes = processAttributesMutations(
    filteredMutations.filter(function (mutation) {
      return (
        mutation.type === 'attributes' && !hasBeenSerialized(mutation.target)
      )
    }),
    configuration,
    nodePrivacyLevelCache
  )
  if (!texts.length && !attributes.length && !removes.length && !adds.length) {
    return
  }
  mutationCallback({
    adds: adds,
    removes: removes,
    texts: texts,
    attributes: attributes
  })
}

function processChildListMutations(
  mutations,
  configuration,
  shadowRootsController,
  nodePrivacyLevelCache
) {
  // First, we iterate over mutations to collect:
  //
  // * nodes that have been added in the document and not removed by a subsequent mutation
  // * nodes that have been removed from the document but were not added in a previous mutation
  //
  // For this second category, we also collect their previous parent (mutation.target) because we'll
  // need it to emit a 'remove' mutation.
  //
  // Those two categories may overlap: if a node moved from a position to another, it is reported as
  // two mutation records, one with a "removedNodes" and the other with "addedNodes". In this case,
  // the node will be in both sets.
  var addedAndMovedNodes = new Set()
  var removedNodes = new Map()
  for (var _i = 0, mutations_1 = mutations; _i < mutations_1.length; _i++) {
    var mutation = mutations_1[_i]
    mutation.addedNodes.forEach(function (node) {
      addedAndMovedNodes.add(node)
    })
    mutation.removedNodes.forEach(function (node) {
      if (!addedAndMovedNodes.has(node)) {
        removedNodes.set(node, mutation.target)
      }
      addedAndMovedNodes.delete(node)
    })
  }

  // Then, we sort nodes that are still in the document by topological order, for two reasons:
  //
  // * We will serialize each added nodes with their descendants. We don't want to serialize a node
  // twice, so we need to iterate over the parent nodes first and skip any node that is contained in
  // a precedent node.
  //
  // * To emit "add" mutations, we need references to the parent and potential next sibling of each
  // added node. So we need to iterate over the parent nodes first, and when multiple nodes are
  // siblings, we want to iterate from last to first. This will ensure that any "next" node is
  // already serialized and have an id.
  var sortedAddedAndMovedNodes = Array.from(addedAndMovedNodes)
  sortAddedAndMovedNodes(sortedAddedAndMovedNodes)

  // Then, we iterate over our sorted node sets to emit mutations. We collect the newly serialized
  // node ids in a set to be able to skip subsequent related mutations.
  var serializedNodeIds = new Set()

  var addedNodeMutations = []
  for (
    var _a = 0, sortedAddedAndMovedNodes_1 = sortedAddedAndMovedNodes;
    _a < sortedAddedAndMovedNodes_1.length;
    _a++
  ) {
    var node = sortedAddedAndMovedNodes_1[_a]
    if (hasBeenSerialized(node)) {
      continue
    }

    var parentNodePrivacyLevel = getNodePrivacyLevel(
      node.parentNode,
      configuration.defaultPrivacyLevel,
      nodePrivacyLevelCache
    )
    if (
      parentNodePrivacyLevel === NodePrivacyLevel.HIDDEN ||
      parentNodePrivacyLevel === NodePrivacyLevel.IGNORE
    ) {
      continue
    }

    var serializedNode = serializeNodeWithId(node, {
      serializedNodeIds: serializedNodeIds,
      parentNodePrivacyLevel: parentNodePrivacyLevel,
      serializationContext: {
        status: SerializationContextStatus.MUTATION,
        shadowRootsController: shadowRootsController
      },
      configuration
    })
    if (!serializedNode) {
      continue
    }

    var parentNode = getParentNode(node)
    addedNodeMutations.push({
      nextId: getNextSibling(node),
      parentId: getSerializedNodeId(parentNode),
      node: serializedNode
    })
  }
  // Finally, we emit remove mutations.
  var removedNodeMutations = []
  removedNodes.forEach(function (parent, node) {
    if (hasSerializedNode(node)) {
      removedNodeMutations.push({
        parentId: getSerializedNodeId(parent),
        id: getSerializedNodeId(node)
      })
    }
  })

  return {
    adds: addedNodeMutations,
    removes: removedNodeMutations,
    serializedNodeIds: serializedNodeIds,
    hasBeenSerialized: hasBeenSerialized
  }

  function hasBeenSerialized(node) {
    return (
      hasSerializedNode(node) &&
      serializedNodeIds.has(getSerializedNodeId(node))
    )
  }

  function getNextSibling(node) {
    var nextSibling = node.nextSibling
    while (nextSibling) {
      if (hasSerializedNode(nextSibling)) {
        return getSerializedNodeId(nextSibling)
      }
      nextSibling = nextSibling.nextSibling
    }

    return null
  }
}

function processCharacterDataMutations(
  mutations,
  configuration,
  nodePrivacyLevelCache
) {
  var textMutations = []

  // Deduplicate mutations based on their target node
  var handledNodes = new Set()
  var filteredMutations = mutations.filter(function (mutation) {
    if (handledNodes.has(mutation.target)) {
      return false
    }
    handledNodes.add(mutation.target)
    return true
  })

  // Emit mutations
  for (
    var _i = 0, filteredMutations_1 = filteredMutations;
    _i < filteredMutations_1.length;
    _i++
  ) {
    var mutation = filteredMutations_1[_i]
    var value = mutation.target.textContent
    if (value === mutation.oldValue) {
      continue
    }

    var parentNodePrivacyLevel = getNodePrivacyLevel(
      getParentNode(mutation.target),
      configuration.defaultPrivacyLevel,
      nodePrivacyLevelCache
    )
    if (
      parentNodePrivacyLevel === NodePrivacyLevel.HIDDEN ||
      parentNodePrivacyLevel === NodePrivacyLevel.IGNORE
    ) {
      continue
    }

    textMutations.push({
      id: getSerializedNodeId(mutation.target),
      value: isNullUndefinedDefaultValue(
        getTextContent(
          configuration,
          mutation.target,
          false,
          parentNodePrivacyLevel,
          null
        )
      )
    })
  }

  return textMutations
}

function processAttributesMutations(
  mutations,
  configuration,
  nodePrivacyLevelCache
) {
  var attributeMutations = []

  // Deduplicate mutations based on their target node and changed attribute
  var handledElements = new Map()
  var filteredMutations = mutations.filter(function (mutation) {
    var handledAttributes = handledElements.get(mutation.target)
    if (handledAttributes && handledAttributes.has(mutation.attributeName)) {
      return false
    }
    if (!handledAttributes) {
      handledElements.set(mutation.target, new Set([mutation.attributeName]))
    } else {
      handledAttributes.add(mutation.attributeName)
    }
    return true
  })

  // Emit mutations
  var emittedMutations = new Map()
  for (
    var _i = 0, filteredMutations_2 = filteredMutations;
    _i < filteredMutations_2.length;
    _i++
  ) {
    var mutation = filteredMutations_2[_i]
    var uncensoredValue = mutation.target.getAttribute(mutation.attributeName)
    if (uncensoredValue === mutation.oldValue) {
      continue
    }
    var privacyLevel = getNodePrivacyLevel(
      mutation.target,
      configuration.defaultPrivacyLevel,
      nodePrivacyLevelCache
    )
    var attributeValue = serializeAttribute(
      mutation.target,
      privacyLevel,
      mutation.attributeName,
      configuration
    )

    var transformedValue
    if (mutation.attributeName === 'value') {
      var inputValue = getElementInputValue(
        configuration,
        mutation.target,
        privacyLevel
      )
      if (inputValue === undefined) {
        continue
      }
      transformedValue = inputValue
    } else if (typeof attributeValue === 'string') {
      transformedValue = attributeValue
    } else {
      transformedValue = null
    }

    var emittedMutation = emittedMutations.get(mutation.target)
    if (!emittedMutation) {
      emittedMutation = {
        id: getSerializedNodeId(mutation.target),
        attributes: {}
      }
      attributeMutations.push(emittedMutation)
      emittedMutations.set(mutation.target, emittedMutation)
    }

    emittedMutation.attributes[mutation.attributeName] = transformedValue
  }

  return attributeMutations
}

export function sortAddedAndMovedNodes(nodes) {
  nodes.sort(function (a, b) {
    var position = a.compareDocumentPosition(b)
    /* eslint-disable no-bitwise */
    if (position & Node.DOCUMENT_POSITION_CONTAINED_BY) {
      return -1
    } else if (position & Node.DOCUMENT_POSITION_CONTAINS) {
      return 1
    } else if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return 1
    } else if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return -1
    }
    /* eslint-enable no-bitwise */
    return 0
  })
}
function traverseRemovedShadowDom(removedNode, shadowDomRemovedCallback) {
  if (isNodeShadowHost(removedNode)) {
    shadowDomRemovedCallback(removedNode.shadowRoot)
  }
  forEachChildNodes(removedNode, function (childNode) {
    return traverseRemovedShadowDom(childNode, shadowDomRemovedCallback)
  })
}
