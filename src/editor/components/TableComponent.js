import {
  CustomSurface, platform,
  DefaultDOMElement as DOM, domHelpers, getRelativeBoundingRect,
  keys
} from 'substance'
import TableEditing from '../../article/TableEditing'
import {
  computeSelectionRectangle, shifted,
  getSelectedRange, getSelDataForRowCol
} from '../../article/tableHelpers'
import TableClipboard from '../util/TableClipboard'
import TableCellEditor from './TableCellEditor'
import TableContextMenu from './TableContextMenu'

export default class TableComponent extends CustomSurface {

  constructor(...args) {
    super(...args)

    this._selectionData = {}
    this._tableEditing = new TableEditing(this.context.editorSession, this.props.node.id, this.getId())
    this._clipboard = new TableClipboard(this._tableEditing)
  }

  getChildContext() {
    return {
      surface: this,
      parentSurfaceId: this.getId(),
      // HACK: nulling this so that nested surfaces get an id that are relative to
      // this surface instead of the isolatedNodeComponent
      isolatedNodeComponent: null
    }
  }

  shouldRerender() {
    return false
  }

  didMount() {
    super.didMount()

    this._tableSha = this.props.node._getSha()

    this.context.editorSession.onRender('document', this._onDocumentChange, this)
    this.context.editorSession.onRender('selection', this._onSelectionChange, this)

    this._positionSelection(this._getSelectionData())
  }

  dispose() {
    super.dispose()

    this.context.editorSession.off(this)
  }

  render($$) {
    let el = $$('div').addClass('sc-table')
    el.on('mousedown', this._onMousedown)
      .on('mouseup', this._onMouseup)
    el.append(this._renderTable($$))
    el.append(this._renderKeyTrap($$))
    el.append(this._renderUnclickableOverlays($$))
    // el.append(this._renderClickableOverlays($$))
    el.append(this._renderContextMenu($$))
    return el
  }

  _renderTable($$) {
    let table = $$('table').ref('table')
    let node = this.props.node
    let matrix = node.getCellMatrix()
    for (let i = 0; i < matrix.length; i++) {
      let cells = matrix[i]
      let tr = $$('tr')
      for (let j = 0; j < cells.length; j++) {
        while (!cells[j]) j++
        if (j >= cells.length) break
        let cell = cells[j]
        let cellEl = $$(cell.attr('heading') ? 'th' : 'td')
        let attributes = {
          id: cell.id,
          "data-row-idx": cell.rowIdx,
          "data-col-idx": cell.colIdx
        }
        let rowspan = cell.attr('rowspan') || 0
        if (rowspan) {
          rowspan = parseInt(rowspan, 10)
          attributes.rowspan = rowspan
        }
        let colspan = cell.attr('colspan') || 0
        if (colspan) {
          colspan = parseInt(colspan, 10)
          attributes.colspan = colspan
        }
        cellEl.attr(attributes)
        cellEl.append(
          $$(TableCellEditor, {
            path: cell.getPath(),
            disabled: true
          }).ref(cell.id)
          .on('enter', this._onCellEnter)
          .on('tab', this._onCellTab)
          .on('escape', this._onCellEscape)
        )
        _clearSpanned(matrix, i, j, rowspan, colspan)
        tr.append(cellEl)
      }
      table.append(tr)
    }
    table.on('mousemove', this._onMousemove)
      .on('dblclick', this._onDblclick)
      .on('contextmenu', this._onContextMenu)
      .on('contextmenuitemclick', this._onContextmenuitemclick)
    return table
  }

  _renderKeyTrap($$) {
    return $$('textarea').addClass('se-keytrap').ref('keytrap')
      .css({ position: 'absolute', width: 0, height: 0 })
      .on('keydown', this._onKeydown)
      .on('input', this._onInput)
      .on('copy', this._onCopy)
      .on('paste', this._onPaste)
      .on('cut', this._onCut)
  }

  _renderUnclickableOverlays($$) {
    let el = $$('div').addClass('se-unclickable-overlays')
    el.append(
      this._renderSelectionOverlay($$)
    )
    el.append(
      this.props.unclickableOverlays
    )
    return el
  }

  _renderSelectionOverlay($$) {
    let el = $$('div').addClass('se-selection-overlay')
    el.append(
      $$('div').addClass('se-selection-anchor').ref('selAnchor').css('visibility', 'hidden'),
      $$('div').addClass('se-selection-range').ref('selRange').css('visibility', 'hidden')
    )
    return el
  }

  _renderContextMenu($$) {
    const configurator = this.context.configurator
    let contextMenu = $$(TableContextMenu, {
      toolPanel: configurator.getToolPanel('table-context-menu')
    }).ref('contextMenu')
      .addClass('se-context-menu')
      .css({ display: 'none' })
    return contextMenu
  }

  _onDocumentChange() {
    const table = this.props.node
    // Note: using a simplified way to detect when a table
    // has changed structurally
    // TableElementNode is detecting such changes and
    // updates an internal 'sha' that we can compare against
    if (table._hasShaChanged(this._tableSha)) {
      console.log('TABLE HAS CHANGED')
      this.rerender()
      this._tableSha = table._getSha()
    }
  }

  _onSelectionChange(sel) {
    const self = this
    if (!sel || sel.isNull()) {
      _disableActiveCell()
      this._hideSelection()
    } else if (sel.isPropertySelection()) {
      let nodeId = sel.path[0]
      if (this._activeCell !== nodeId) {
        _disableActiveCell()
        let newCellEditor = this.refs[nodeId]
        if (newCellEditor) {
          // console.log('ENABLING CELL EDITOR', nodeId)
          newCellEditor.extendProps({ disabled: false })
          this._activeCell = nodeId
        }
      }
      if (this._activeCell) {
        // TODO: this could be simplified
        let doc = this.context.editorSession.getDocument()
        let cell = doc.get(this._activeCell)
        this._positionSelection({
          type: 'range',
          anchorRow: cell.rowIdx,
          anchorCol: cell.colIdx,
          focusRow: cell.rowIdx,
          focusCol: cell.colIdx
        }, true)
      } else {
        this._hideSelection()
      }
    } else if (sel.surfaceId !== this.getId()) {
      _disableActiveCell()
      this._hideSelection()
    } else {
      _disableActiveCell()
    }
    this._hideContextMenu()

    function _disableActiveCell() {
      const activeCellId = self._activeCell
      if(activeCellId) {
        let cellEditor = self.refs[activeCellId]
        if (cellEditor) {
          // console.log('DISABLING CELL EDITOR', activeCellId)
          cellEditor.extendProps({ disabled: true })
        }
        self._activeCell = null
      }
    }

  }

  _onMousedown(e) {
    e.stopPropagation()
    // TODO: do not update the selection if right-clicked and already having a selection
    if (platform.inBrowser) {
      DOM.wrap(window.document).on('mouseup', this._onMouseup, this, {
        once: true
      })
    }
    console.log('_onMousedown', e)
    let selData = this._selectionData
    let target = this._getClickTargetForEvent(e)
    console.log('target', target)
    if (!target) return

    let isRightButton = domHelpers.isRightButton(e)
    if (isRightButton) {
      console.log('IS RIGHT BUTTON')
      // this will be handled by onContextMenu
      if (target.type === 'cell') {
        let _needSetSelection = true
        let sel = this._getSelectionData()
        if (sel.type === 'range') {
          let startRow = Math.min(selData.anchorRow, selData.focusRow)
          let endRow = Math.max(selData.anchorRow, selData.focusRow)
          let startCol = Math.min(selData.anchorCol, selData.focusCol)
          let endCol = Math.max(selData.anchorCol, selData.focusCol)
          _needSetSelection = (
            target.colIdx < startCol || target.colIdx > endCol ||
            target.rowIdx < startRow || target.rowIdx > endRow
          )
        }
        if (_needSetSelection) {
          this._isSelecting = true
          selData.anchorRow = target.rowIdx
          selData.focusRow = target.rowIdx
          selData.anchorCol = target.colIdx
          selData.focusCol = target.colIdx
          this._requestSelectionChange(this._tableEditing.createTableSelection(selData))
        }
      }
      return
    }

    if (target.type === 'cell') {
      this._isSelecting = true
      selData.focusRow = target.rowIdx
      selData.focusCol = target.colIdx
      if (!e.shiftKey || !selData.hasOwnProperty('anchorRow')) {
        selData.anchorRow = selData.focusRow
        selData.anchorCol = selData.focusCol
      }
      e.preventDefault()
      this._requestSelectionChange(this._tableEditing.createTableSelection(selData))
    }
  }

  _onMouseup(e) {
    e.stopPropagation()
    if (this._isSelecting) {
      e.preventDefault()
      this._isSelecting = false
    }
  }

  _onMousemove(e) {
    if (this._isSelecting) {
      const selData = this._selectionData
      let [rowIdx, colIdx] = this._mapClientXYToRowCol(e.clientX, e.clientY)
      if (rowIdx !== selData.focusRow || colIdx !== selData.focusCol) {
        if (rowIdx >= 0 && colIdx >= 0) {
          selData.focusRow = rowIdx
          selData.focusCol = colIdx
          this._requestSelectionChange(this._tableEditing.createTableSelection(selData))
        }
      }
    }
  }

  _onDblclick(e) {
    e.preventDefault()
    e.stopPropagation()
    this._requestEditCell()
  }

  _onKeydown(e) {
    let handled = false
    switch (e.keyCode) {
      case keys.LEFT:
        this._nav(0, -1, e.shiftKey)
        handled = true
        break
      case keys.RIGHT:
        this._nav(0, 1, e.shiftKey)
        handled = true
        break
      case keys.UP:
        this._nav(-1, 0, e.shiftKey)
        handled = true
        break
      case keys.DOWN:
        this._nav(1, 0, e.shiftKey)
        handled = true
        break
      case keys.ENTER: {
        this._requestEditCell()
        handled = true
        break
      }
      case keys.TAB: {
        this._nav(0, 1)
        handled = true
        break
      }
      case keys.DELETE:
      case keys.BACKSPACE: {
        this._clearSelection()
        handled = true
        break
      }
      default:
        //
    }
    // let an optional keyboard manager handle the key
    if (!handled) {
      const keyboardManager = this.context.keyboardManager
      if (keyboardManager) {
        handled = keyboardManager.onKeydown(e)
      }
    }
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  /*
    Type into cell (replacing the existing content)
  */
  _onInput() {
    const value = this.refs.keytrap.val()
    this._requestEditCell(value)
    // Clear keytrap after sending an action
    this.refs.keytrap.val('')
  }

  _onCellEnter(e) {
    e.stopPropagation()
    e.preventDefault()
    let cellEl = DOM.wrap(e.target).getParent()
    if (e.detail.shiftKey) {
      this._tableEditing.insertSoftBreak()
    } else {
      let [rowIdx, colIdx] = this._getRowCol(cellEl)
      this._nav(1, 0, false, getSelDataForRowCol(rowIdx, colIdx))
    }
  }

  _onCellTab(e) {
    e.stopPropagation()
    e.preventDefault()
    let cellEl = DOM.wrap(e.target).getParent()
    let [rowIdx, colIdx] = this._getRowCol(cellEl)
    this._nav(0, 1, false, getSelDataForRowCol(rowIdx, colIdx))
  }

  _onCellEscape(e) {
    e.stopPropagation()
    e.preventDefault()
    let cellEl = DOM.wrap(e.target).getParent()
    let [rowIdx, colIdx] = this._getRowCol(cellEl)
    this._requestSelectionChange(this._tableEditing.createTableSelection(getSelDataForRowCol(rowIdx, colIdx)))
  }

  _onCopy(e) {
    this._clipboard.onCopy(e)
  }

  _onPaste(e) {
    this._clipboard.onPaste(e)
  }

  _onCut(e) {
    this._clipboard.onCut(e)
  }

  _onContextMenu(e) {
    e.preventDefault()
    e.stopPropagation()
    this._showContextMenu(e)
  }

  _onContextmenuitemclick(e) {
    e.preventDefault()
    e.stopPropagation()
    this._hideContextMenu()
  }

  _getSelection() {
    return this.context.editorSession.getSelection()
  }

  _getSelectionData() {
    let sel = this._getSelection()
    if (sel && sel.surfaceId === this.getId()) {
      return sel.data || {}
    }
    return {}
  }

  _requestEditCell(initialValue) {
    let selData = this._getSelectionData()
    if (selData.hasOwnProperty('anchorRow')) {
      let table = this._tableEditing.getTable()
      let cell = table.getCell(selData.anchorRow, selData.anchorCol)
      this._tableEditing.editCell(cell.id, initialValue)
    }
  }

  _requestSelectionChange(newSel) {
    console.log('requesting selection change', newSel)
    if (newSel) newSel.surfaceId = this.getId()
    this.context.editorSession.setSelection(newSel)
  }

  _getClickTargetForEvent(e) {
    let target = DOM.wrap(e.target)
    let cellEl = domHelpers.findParent(target, 'td,th')
    if (cellEl) {
      let [rowIdx, colIdx] = this._getRowCol(cellEl)
      return { type: 'cell', rowIdx, colIdx }
    }
  }

  _getRowCol(cellEl) {
    let rowIdx = parseInt(cellEl.getAttribute('data-row-idx'), 10)
    let colIdx = parseInt(cellEl.getAttribute('data-col-idx'), 10)
    return [rowIdx, colIdx]
  }

  _mapClientXYToRowCol(x, y) {
    // TODO: this could be optimized using bisect search
    let cellEls = this.refs.table.findAll('th,td')
    for (let i = 0; i < cellEls.length; i++) {
      let cellEl = cellEls[i]
      let rect = domHelpers.getBoundingRect(cellEl)
      if (domHelpers.isXInside(x, rect) && domHelpers.isYInside(y, rect)) {
        return this._getRowCol(cellEl)
      }
    }
    return [-1,-1]
  }

  _nav(dr, dc, shift, selData) {
    selData = selData || this._getSelectionData()
    let newSelData = shifted(this.props.node, selData, dr, dc, shift)
    this._requestSelectionChange(this._tableEditing.createTableSelection(newSelData))
  }

  _getCustomResourceId() {
    return this.props.node.id
  }

  _clearSelection() {
    let { startRow, startCol, endRow, endCol } = getSelectedRange(this.props.node, this._getSelectionData())
    this._tableEditing.clearValues(startRow, startCol, endRow, endCol)
  }

  rerenderDOMSelection() {
    // console.log('SheetComponent.rerenderDOMSelection()')
    this._positionSelection(this._getSelectionData())
    // // put the native focus into the keytrap so that we
    // // receive keyboard events
    this.refs.keytrap.el.focus()
  }

  _positionSelection(selData, focused) {
    if (selData.type) {
      let rects = this._computeSelectionRects(selData, selData.type)
      let styles = this._computeSelectionStyles(selData, rects)
      this.refs.selAnchor.css(styles.anchor)
      if (focused) {
        this.refs.selRange.css('visibility', 'hidden')
      } else {
        this.refs.selRange.css(styles.range)
      }
    } else {
      this._hideSelection()
    }
  }

  _hideSelection() {
    this.refs.selAnchor.css('visibility', 'hidden')
    this.refs.selRange.css('visibility', 'hidden')
  }

  _hideContextMenu() {
    this.refs.contextMenu.addClass('sm-hidden')
  }

  _showContextMenu(e) {
    let contextMenu = this.refs.contextMenu
    let offset = this.el.getOffset()
    contextMenu.css({
      display: 'block',
      top: e.clientY - offset.top,
      left: e.clientX - offset.left
    })
    contextMenu.removeClass('sm-hidden')
  }


  _getBoundingRect(rowIdx, colIdx) {
    let rowEl = this.refs.table.el.getChildAt(rowIdx)
    let cellEl = rowEl.getChildAt(colIdx)
    return getRelativeBoundingRect(cellEl, this.el)
  }

  _computeSelectionRects(data, type) {
    let { anchor, range } = this._getAnchorAndRange(data, type)
    let { ul, lr } = range
    // TODO: We need to improve rendering for range selections
    // that are outside of the viewport
    let anchorRect = this._getBoundingRect(anchor.row, anchor.col)
    let ulRect = this._getBoundingRect(ul.row, ul.col)
    let lrRect = this._getBoundingRect(lr.row, lr.col)
    let selRect
    if (ulRect && lrRect) {
      selRect = computeSelectionRectangle(ulRect, lrRect)
    }
    return { anchorRect, selRect, ulRect, lrRect}
  }

  _getAnchorAndRange(data, type) {
    let anchorRow, anchorCol
    let ulRow, ulCol, lrRow, lrCol
    switch(type) {
      case 'range': {
        anchorRow = data.anchorRow
        anchorCol = data.anchorCol
        let focusRow = data.focusRow
        let focusCol = data.focusCol
        let startRow = anchorRow
        let startCol = anchorCol
        let endRow = focusRow
        let endCol = focusCol
        if (startRow > endRow) {
          [startRow, endRow] = [endRow, startRow]
        }
        if (startCol > endCol) {
          [startCol, endCol] = [endCol, startCol]
        }
        [ulRow, ulCol] = [startRow, startCol]
        ;[lrRow, lrCol] = [endRow, endCol]
        break
      }
      default:
        //
    }
    let anchor = { row: anchorRow, col: anchorCol }
    let range = { ul: { row: ulRow, col: ulCol }, lr: { row: lrRow, col: lrCol } }
    return { anchor, range }
  }

  _computeSelectionStyles(data, { anchorRect, ulRect, lrRect }) {
    let styles = {
      range: { visibility: 'hidden' },
      anchor: { visibility: 'hidden' }
    }
    if (anchorRect && anchorRect.width && anchorRect.height) {
      Object.assign(styles, this._computeAnchorStyles(anchorRect))
    }
    if (ulRect && lrRect) {
      Object.assign(
        styles,
        this._computeRangeStyles(ulRect, lrRect, data.type)
      )
    }
    return styles
  }

  _computeAnchorStyles(anchorRect) {
    let styles = {
      anchor: { visibility: 'hidden' }
    }
    if (anchorRect) {
      Object.assign(styles.anchor, anchorRect)
      if (
        isFinite(anchorRect.top) &&
        isFinite(anchorRect.left) &&
        isFinite(anchorRect.width) &&
        isFinite(anchorRect.height)
      ) {
        styles.anchor.visibility = 'visible'
      }
    }
    return styles
  }

  _computeRangeStyles(ulRect, lrRect) {
    let styles = {
      range: { visibility: 'hidden' },
    }
    styles.range.top = ulRect.top
    styles.range.left = ulRect.left
    styles.range.width = lrRect.left + lrRect.width - styles.range.left
    styles.range.height = lrRect.top + lrRect.height - styles.range.top
    styles.range.visibility = 'visible'
    return styles
  }

}

function _clearSpanned(matrix, row, col, rowspan, colspan) {
  if (!rowspan && !colspan) return
  for (let i = row; i <= row + rowspan; i++) {
    for (let j = col; j <= col + colspan; j++) {
      if (i === row && j === col) continue
      matrix[i][j] = false
    }
  }
}