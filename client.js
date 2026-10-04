window.__ModuleLoader__.load({
  id: "dsh-flow",
  factory(require) {
    const React = require('react')
    const h = React.createElement
    function Decoration() {
      return h('div', { style: { padding: '4px 8px' } }, 'hello from flow')
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: "flow", order: 5,
        }, Decoration))
      },
    }
  },
})
